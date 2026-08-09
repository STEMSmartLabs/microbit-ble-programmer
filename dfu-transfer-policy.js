const PATCH_FLAG = Symbol.for('stem.microbit.checksumPacedFirmwareTransferV243');
const DATA_OBJECT = 0x02;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function installChecksumPacedFirmwareTransfer(NordicSecureDfu) {
  const prototype = NordicSecureDfu?.prototype;
  if (!prototype || typeof prototype.transferFirmware !== 'function') return false;
  if (prototype[PATCH_FLAG]) return true;

  Object.defineProperty(prototype, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  prototype.transferFirmware = async function (firmware) {
    const selected = await this.selectObject(DATA_OBJECT);
    const maxSize = selected.maxSize;
    if (!maxSize) throw new Error('Bootloader reported a zero-sized data object');

    let offset = selected.offset;
    this.log(`DFU data object: max ${maxSize} B, resume offset ${offset}.`);
    this.progress({ type: 'firmware', currentBytes: offset, totalBytes: firmware.length });

    if (offset > firmware.length || !this.verifyPrefix(firmware, offset, selected.crc)) {
      if (offset !== 0) {
        throw new Error('Bootloader has a partial DFU image with a different CRC. Power-cycle the micro:bit and retry the full flash.');
      }
      offset = 0;
    }

    if (offset === firmware.length) {
      this.log('Firmware bytes are already present; executing image.');
      await this.execute();
      return;
    }

    let flowPolicyAnnounced = false;
    while (offset < firmware.length) {
      const objectStart = Math.floor(offset / maxSize) * maxSize;
      const objectEnd = Math.min(objectStart + maxSize, firmware.length);

      if (offset === objectStart) {
        await this.createObject(DATA_OBJECT, objectEnd - objectStart);
      } else {
        this.log(`Resuming data object at ${offset} of ${objectEnd}.`);
      }

      let sendOffset = offset;
      let recoveryAttempt = 0;
      while (sendOffset < objectEnd) {
        // Web Bluetooth writeWithoutResponse promises only confirm that the host
        // accepted the packet. PRNs can arrive stale or out of phase on some
        // stacks, so v2.4.3 disables PRNs and treats the bootloader's explicit
        // Calculate Checksum response as the authoritative progress/CRC source.
        await this.setPacketReceiptNotifications(0);
        if (!flowPolicyAnnounced) {
          this.log('DFU firmware flow control: Packet Receipt Notifications disabled; validating each data object with the bootloader checksum.');
          flowPolicyAnnounced = true;
        }

        const recoveringTail = recoveryAttempt > 0;
        const packetDelayMs = recoveringTail
          ? Math.max(Number(this.recoveryPacketDelayMs) || 0, 12)
          : Math.max(Number(this.packetDelayMs) || 0, 8);

        await this.writePackets(
          firmware.slice(sendOffset, objectEnd),
          sendOffset,
          'firmware',
          {
            receiptInterval: 0,
            packetDelayMs,
          },
        );

        if (this.objectDrainDelayMs > 0) await sleep(this.objectDrainDelayMs);
        const checksum = await this.checksum();
        const prefixMatches = this.verifyPrefix(firmware, checksum.offset, checksum.crc);

        if (checksum.offset === objectEnd && prefixMatches) {
          sendOffset = objectEnd;
          break;
        }

        if (!prefixMatches) {
          throw new Error(`Firmware CRC mismatch at byte ${checksum.offset}: the received data does not match the firmware prefix`);
        }
        if (checksum.offset < objectStart || checksum.offset > objectEnd) {
          throw new Error(`Unexpected DFU firmware offset ${checksum.offset}; expected ${objectStart}–${objectEnd}`);
        }

        recoveryAttempt++;
        if (recoveryAttempt > this.maxTailRecoveryAttempts) {
          throw new Error(`Firmware transfer remained short at byte ${checksum.offset} after ${this.maxTailRecoveryAttempts} recovery attempt${this.maxTailRecoveryAttempts === 1 ? '' : 's'}`);
        }

        const missing = objectEnd - checksum.offset;
        this.log(`Bootloader checksum confirms ${checksum.offset} bytes; retransmitting the remaining ${missing} byte${missing === 1 ? '' : 's'} with slower pacing.`, 'warn');
        sendOffset = checksum.offset;
      }

      await this.execute();
      offset = objectEnd;
      this.log(`Executed ${offset} of ${firmware.length} firmware bytes.`);
    }
  };

  return true;
}
