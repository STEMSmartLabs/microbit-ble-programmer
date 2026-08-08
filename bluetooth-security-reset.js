/**
 * Work around a macOS/Chrome Web Bluetooth failure mode seen while authorizing
 * the bonded micro:bit Buttonless DFU characteristic (UUID ending 0004).
 *
 * Chrome can reject startNotifications() with an implementation-specific GATT
 * error while still reporting the GATT link as connected. Reusing that link for
 * another secured operation can then fail in the same way. For this one secured
 * characteristic only, force a clean GATT disconnect after an authorization
 * error so the existing application state machine reconnects and rediscovers
 * the services before the next attempt or the final DFU command.
 */

const BONDED_BUTTONLESS_DFU_UUID = '8ec90004-f315-4f60-9fb8-838830daea50';
const PATCH_FLAG = Symbol.for('stem.microbit.bondedDfuSecurityReset');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function normalizedUuid(characteristic) {
  return characteristic?.uuid?.toLowerCase?.() ?? String(characteristic?.uuid || '').toLowerCase();
}

export function installBondedDfuSecurityReset() {
  const prototype = globalThis.BluetoothRemoteGATTCharacteristic?.prototype;
  if (!prototype || typeof prototype.startNotifications !== 'function') return false;
  if (prototype[PATCH_FLAG]) return true;

  const originalStartNotifications = prototype.startNotifications;

  Object.defineProperty(prototype, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  prototype.startNotifications = async function (...args) {
    try {
      return await originalStartNotifications.apply(this, args);
    } catch (error) {
      if (normalizedUuid(this) === BONDED_BUTTONLESS_DFU_UUID) {
        const gatt = this.service?.device?.gatt;
        if (gatt?.connected) {
          try { gatt.disconnect(); } catch {}
          // Give the host stack a short window to retire the failed encrypted
          // GATT transaction before the application reconnect loop starts.
          await sleep(300);
        }
      }
      throw error;
    }
  };

  return true;
}

installBondedDfuSecurityReset();
