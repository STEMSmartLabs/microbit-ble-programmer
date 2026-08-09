const PATCH_FLAG = Symbol.for('stem.microbit.verifiedDfuResumeV249');
const VERIFIED_FLAG = Symbol.for('stem.microbit.secureDfuVerified');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const CONTROL_NAMES = Object.freeze({
  0x01: 'Create Object',
  0x02: 'Set Packet Receipt Notifications',
  0x03: 'Calculate Checksum',
  0x04: 'Execute Object',
  0x06: 'Select Object',
});

function copyErrorMetadata(target, source) {
  if (source?.code) target.code = source.code;
  if (source?.name && source.name !== 'Error') target.name = source.name;
  target.cause = source;
  return target;
}

function transportError(message, source) {
  return copyErrorMetadata(new Error(message), source);
}

function isRecoverableTransportError(error) {
  if (!error) return false;
  if (['DFU_CANDIDATE_APPLICATION', 'DFU_CANDIDATE_UNSUPPORTED'].includes(error.code)) return false;
  const text = `${error.name || ''} ${error.message || ''}`.toLowerCase();
  return (
    text.includes('gatt')
    || text.includes('connection attempt failed')
    || text.includes('dfu device disconnected')
    || text.includes('device disconnected')
    || text.includes('networkerror')
    || text.includes('timed out connecting')
    || text.includes('timed out enabling secure dfu')
    || text.includes('timed out waiting for dfu opcode')
  );
}

async function reconnectSelectedBootloader(device, timeoutMs) {
  if (!device?.gatt?.connect) throw new Error('The verified Secure DFU device no longer exposes a GATT connection');
  if (device.gatt.connected) return device.gatt;

  let timer = null;
  try {
    return await Promise.race([
      device.gatt.connect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { device.gatt.disconnect(); } catch {}
          reject(new Error(`Timed out reconnecting to the verified Secure DFU bootloader after ${Math.round(timeoutMs / 100) / 10} seconds`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function installVerifiedDfuResume(NordicSecureDfu, {
  reconnectDelaysMs = [2000, 3000, 5000],
  connectionTimeoutMs = 7000,
} = {}) {
  const prototype = NordicSecureDfu?.prototype;
  if (!prototype || typeof prototype.update !== 'function' || typeof prototype.connect !== 'function') return false;
  if (prototype[PATCH_FLAG]) return true;

  const originalConnect = prototype.connect;
  const originalUpdate = prototype.update;
  const originalSetPrn = prototype.setPacketReceiptNotifications;
  const originalSendControl = prototype.sendControl;
  const originalWritePackets = prototype.writePackets;

  Object.defineProperty(prototype, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  if (typeof originalSetPrn === 'function') {
    prototype.setPacketReceiptNotifications = async function (interval, options = {}) {
      const normalized = Math.max(0, Math.min(0xffff, Math.floor(Number(interval) || 0)));
      if (this.lastConfiguredPrn === normalized) return;
      return originalSetPrn.call(this, normalized, options);
    };
  }

  if (typeof originalSendControl === 'function') {
    prototype.sendControl = async function (opcode, payload) {
      try {
        return await originalSendControl.call(this, opcode, payload);
      } catch (error) {
        const label = CONTROL_NAMES[opcode] || 'Control operation';
        const hex = Number(opcode).toString(16).padStart(2, '0');
        throw transportError(`DFU control ${label} (opcode 0x${hex}) failed: ${error.message}`, error);
      }
    };
  }

  if (typeof originalWritePackets === 'function') {
    prototype.writePackets = async function (data, baseOffset, type, options) {
      try {
        return await originalWritePackets.call(this, data, baseOffset, type, options);
      } catch (error) {
        const endOffset = Number(baseOffset) + Number(data?.length || 0);
        throw transportError(`DFU ${type || 'data'} packet transfer failed in byte range ${baseOffset}–${endOffset}: ${error.message}`, error);
      }
    };
  }

  prototype.connect = async function (device) {
    const result = await originalConnect.call(this, device);
    this[VERIFIED_FLAG] = true;
    return result;
  };

  prototype.update = async function (device, initPacket, firmware) {
    this[VERIFIED_FLAG] = false;
    let lastError;

    try {
      return await originalUpdate.call(this, device, initPacket, firmware);
    } catch (error) {
      lastError = error;
    }

    if (!this[VERIFIED_FLAG] || !isRecoverableTransportError(lastError)) throw lastError;

    const delays = Array.isArray(reconnectDelaysMs) && reconnectDelaysMs.length
      ? reconnectDelaysMs.map(value => Math.max(0, Number(value) || 0))
      : [2000, 3000, 5000];

    this.log(`Secure DFU transport was interrupted after control 0001 and packet 0002 had already been verified: ${lastError.message}`, 'warn');
    this.log('Keeping the prepared package and automatically resuming from the bootloader-reported offset and CRC. USB recovery is not required while the Secure DFU bootloader remains reachable.', 'warn');

    for (let attempt = 1; attempt <= delays.length; attempt++) {
      const delayMs = delays[attempt - 1];
      if (delayMs > 0) {
        this.log(`Automatic Secure DFU resume ${attempt}/${delays.length}: waiting ${Math.round(delayMs / 100) / 10} seconds before reconnecting to the same verified bootloader…`);
        await sleep(delayMs);
      }

      try {
        await reconnectSelectedBootloader(device, connectionTimeoutMs);
        this.log(`Automatic Secure DFU resume ${attempt}/${delays.length}: GATT reconnected. Re-reading init/data offsets and CRC before sending more firmware.`);
        const result = await originalUpdate.call(this, device, initPacket, firmware);
        this.log(`Automatic Secure DFU resume ${attempt}/${delays.length} completed successfully.`);
        return result;
      } catch (error) {
        lastError = error;
        try { device?.gatt?.disconnect?.(); } catch {}

        if (!isRecoverableTransportError(error)) throw error;
        if (attempt < delays.length) {
          this.log(`Automatic Secure DFU resume ${attempt}/${delays.length} did not complete: ${error.message}`, 'warn');
        }
      }
    }

    const error = new Error(`Secure DFU remains in recovery mode but automatic reconnect could not restore the Bluetooth link after ${delays.length} attempt${delays.length === 1 ? '' : 's'}. The prepared program is still available. Last error: ${lastError?.message || 'unknown transport error'}`);
    error.code = 'DFU_AUTO_RESUME_FAILED';
    error.cause = lastError;
    throw error;
  };

  return true;
}
