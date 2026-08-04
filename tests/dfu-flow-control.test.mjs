import test from 'node:test';
import assert from 'node:assert/strict';
import { NordicSecureDfu, crc32 } from '../dfu.js';

function crcNotification(offset, crc) {
  const bytes = new Uint8Array(11);
  bytes.set([0x60, 0x03, 0x01], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(3, offset, true);
  view.setUint32(7, crc >>> 0, true);
  return new DataView(bytes.buffer);
}

test('Packet Receipt Notification validates a 12-packet window', async () => {
  const firmware = Uint8Array.from({ length: 240 }, (_, index) => index & 0xff);
  const dfu = new NordicSecureDfu({
    packetSize: 20,
    packetDelayMs: 0,
    packetReceiptInterval: 12,
    receiptTimeoutMs: 1000,
  });

  let writes = 0;
  dfu.packet = {
    async writeValueWithoutResponse() {
      writes++;
      if (writes === 12) {
        queueMicrotask(() => {
          dfu.handleNotification({
            target: { value: crcNotification(240, crc32(firmware)) },
          });
        });
      }
    },
  };

  await dfu.writePackets(firmware, 0, 'firmware', {
    verificationData: firmware,
    receiptInterval: 12,
    packetDelayMs: 0,
  });

  assert.equal(writes, 12);
  assert.equal(dfu.pendingReceipt, null);
});

test('short final object tail is retransmitted with per-packet receipts', async () => {
  const firmware = Uint8Array.from({ length: 4096 }, (_, index) => (index * 17) & 0xff);
  const logs = [];
  const dfu = new NordicSecureDfu({
    log: (message, level) => logs.push({ message, level }),
    objectDrainDelayMs: 0,
    maxTailRecoveryAttempts: 2,
  });

  let received = 0;
  let writes = 0;
  let executes = 0;
  const prnValues = [];

  dfu.selectObject = async () => ({ maxSize: 4096, offset: 0, crc: crc32(new Uint8Array()) });
  dfu.createObject = async () => {};
  dfu.setPacketReceiptNotifications = async value => { prnValues.push(value); };
  dfu.writePackets = async (_data, baseOffset) => {
    writes++;
    received = writes === 1 ? 4016 : 4096;
    assert.equal(baseOffset, writes === 1 ? 0 : 4016);
  };
  dfu.checksum = async () => ({ offset: received, crc: crc32(firmware.slice(0, received)) });
  dfu.execute = async () => { executes++; };

  await dfu.transferFirmware(firmware);

  assert.equal(writes, 2);
  assert.equal(executes, 1);
  assert.deepEqual(prnValues, [12, 1]);
  assert.ok(logs.some(entry => entry.message.includes('retransmitting the missing 80 bytes')));
});
