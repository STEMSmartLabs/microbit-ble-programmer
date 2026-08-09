const PATCH_FLAG = Symbol.for('stem.microbit.freshDfuChooserHandoffV244');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function installFreshDfuChooserHandoff(NordicSecureDfu, {
  readinessDelayMs = 1800,
  connectionTimeoutMs = 7000,
} = {}) {
  const prototype = NordicSecureDfu?.prototype;
  if (!prototype || typeof prototype.connectGatt !== 'function') return false;
  if (prototype[PATCH_FLAG]) return true;

  Object.defineProperty(prototype, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  prototype.connectGatt = async function (device) {
    if (device?.gatt?.connected) return device.gatt;
    if (!device?.gatt?.connect) throw new Error('Selected DFU device does not expose a GATT connection');

    const label = device.name || 'unnamed / unknown device';
    if (readinessDelayMs > 0) {
      this.log(`Fresh DFU candidate selected: ${label}. Waiting ${Math.round(readinessDelayMs / 100) / 10} seconds for GATT readiness…`);
      await sleep(readinessDelayMs);
    }

    this.log(`Connecting to freshly selected DFU candidate ${label} (single attempt)…`);
    let timer = null;
    try {
      const server = await Promise.race([
        device.gatt.connect(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { device.gatt.disconnect(); } catch {}
            const error = new Error(`Timed out connecting to the selected Bluetooth device after ${Math.round(connectionTimeoutMs / 100) / 10} seconds`);
            error.code = 'DFU_CANDIDATE_TIMEOUT';
            reject(error);
          }, connectionTimeoutMs);
        }),
      ]);
      this.log(`Bluetooth GATT connected to ${label}. Discovering Nordic Secure DFU service…`);
      return server;
    } catch (error) {
      try { device.gatt.disconnect(); } catch {}
      if (/^Unsupported device\.?$/i.test(String(error?.message || '').trim())) {
        const unsupported = new Error('Unsupported device. Reopen Continue and select another newly discovered Bluetooth entry.');
        unsupported.code = 'DFU_CANDIDATE_UNSUPPORTED';
        throw unsupported;
      }
      error.code ||= 'DFU_CANDIDATE_CONNECT_FAILED';
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return true;
}
