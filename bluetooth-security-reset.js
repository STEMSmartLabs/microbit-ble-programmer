/**
 * Work around a macOS/Chrome Web Bluetooth failure mode seen while authorizing
 * the bonded micro:bit Buttonless DFU characteristic (UUID ending 0004).
 *
 * Policy:
 * 1. Let the first secured startNotifications() attempt reach the host stack.
 * 2. If it fails, force a clean GATT disconnect so the app reconnects and
 *    rediscovers the application services.
 * 3. On the immediately following authorization attempt for the same device,
 *    do not issue another protected CCCD operation. Return a synthetic failure
 *    while keeping the fresh GATT connection alive, so app.js proceeds to the
 *    single secured DFU command on that clean link.
 */

const BONDED_BUTTONLESS_DFU_UUID = '8ec90004-f315-4f60-9fb8-838830daea50';
const PATCH_FLAG = Symbol.for('stem.microbit.bondedDfuSecurityResetV2');
const skipNextAuthorization = new WeakSet();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function normalizedUuid(characteristic) {
  return characteristic?.uuid?.toLowerCase?.() ?? String(characteristic?.uuid || '').toLowerCase();
}

function isBondedButtonless(characteristic) {
  return normalizedUuid(characteristic) === BONDED_BUTTONLESS_DFU_UUID;
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
    if (!isBondedButtonless(this)) {
      return originalStartNotifications.apply(this, args);
    }

    const device = this.service?.device;

    if (device && skipNextAuthorization.has(device)) {
      skipNextAuthorization.delete(device);
      const error = new Error('Repeated bonded authorization intentionally skipped after the first GATT failure');
      error.code = 'DFU_AUTHORIZATION_REPEAT_SKIPPED';
      throw error;
    }

    try {
      return await originalStartNotifications.apply(this, args);
    } catch (error) {
      if (device) skipNextAuthorization.add(device);
      const gatt = device?.gatt;
      if (gatt?.connected) {
        try { gatt.disconnect(); } catch {}
        // Allow the host stack to retire the failed encrypted GATT transaction
        // before the application reconnect loop starts.
        await sleep(300);
      }
      throw error;
    }
  };

  return true;
}

installBondedDfuSecurityReset();
