/**
 * Guard the bonded micro:bit Buttonless DFU characteristic (UUID ending 0004).
 *
 * v2.4.2 policy:
 * 1. Every authorization attempt reaches the real Web Bluetooth stack.
 * 2. A successful startNotifications() on 0004 is the positive proof that the
 *    current host has secured access to the bonded DFU characteristic.
 * 3. If the app later tries to write the DFU reboot command without that proof,
 *    block the write locally. No reboot command is sent and no DFU chooser is
 *    enabled from an unverified bond.
 *
 * The previous branch experiment intentionally skipped the second protected
 * authorization attempt after a GATT failure. That behaviour is removed here.
 */

const BONDED_BUTTONLESS_DFU_UUID = '8ec90004-f315-4f60-9fb8-838830daea50';
const PATCH_FLAG = Symbol.for('stem.microbit.bondedDfuSecurityGuardV242');
const verifiedDevices = new WeakSet();
const responseHandlers = new WeakMap();

function normalizedUuid(characteristic) {
  return characteristic?.uuid?.toLowerCase?.() ?? String(characteristic?.uuid || '').toLowerCase();
}

function isBondedButtonless(characteristic) {
  return normalizedUuid(characteristic) === BONDED_BUTTONLESS_DFU_UUID;
}

function addResponseHandler(characteristic, listener) {
  if (!listener) return;
  let handlers = responseHandlers.get(characteristic);
  if (!handlers) {
    handlers = new Set();
    responseHandlers.set(characteristic, handlers);
  }
  handlers.add(listener);
}

function removeResponseHandler(characteristic, listener) {
  const handlers = responseHandlers.get(characteristic);
  if (!handlers) return;
  handlers.delete(listener);
  if (!handlers.size) responseHandlers.delete(characteristic);
}

function invokeListener(listener, characteristic, event) {
  if (typeof listener === 'function') {
    listener.call(characteristic, event);
  } else if (listener && typeof listener.handleEvent === 'function') {
    listener.handleEvent(event);
  }
}

function signalBlockedDfuWrite(characteristic) {
  const handlers = [...(responseHandlers.get(characteristic) || [])];
  if (!handlers.length) return;

  // enterButtonlessDfu() already has its response listener installed before it
  // writes opcode 0x01. Feed that listener a local "operation failed" response
  // so the transport rejects immediately instead of waiting for its 15 s timer.
  const bytes = Uint8Array.of(0x20, 0x01, 0x0a);
  const event = { target: { value: new DataView(bytes.buffer) } };
  queueMicrotask(() => {
    for (const listener of handlers) {
      try { invokeListener(listener, characteristic, event); } catch {}
    }
  });
}

function unverifiedBondError() {
  const error = new Error('Bluetooth bond has not been verified for Buttonless DFU');
  error.code = 'DFU_BOND_NOT_VERIFIED';
  return error;
}

export function installBondedDfuSecurityGuard() {
  const prototype = globalThis.BluetoothRemoteGATTCharacteristic?.prototype;
  if (!prototype || typeof prototype.startNotifications !== 'function') return false;
  if (prototype[PATCH_FLAG]) return true;

  const originalStartNotifications = prototype.startNotifications;
  const originalAddEventListener = prototype.addEventListener;
  const originalRemoveEventListener = prototype.removeEventListener;
  const originalWriteWithResponse = prototype.writeValueWithResponse;
  const originalWriteWithoutResponse = prototype.writeValueWithoutResponse;
  const originalWriteValue = prototype.writeValue;

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
    try {
      const result = await originalStartNotifications.apply(this, args);
      if (device) verifiedDevices.add(device);
      return result;
    } catch (error) {
      if (device) verifiedDevices.delete(device);
      throw error;
    }
  };

  if (typeof originalAddEventListener === 'function') {
    prototype.addEventListener = function (type, listener, ...args) {
      if (type === 'characteristicvaluechanged' && isBondedButtonless(this)) {
        addResponseHandler(this, listener);
      }
      return originalAddEventListener.call(this, type, listener, ...args);
    };
  }

  if (typeof originalRemoveEventListener === 'function') {
    prototype.removeEventListener = function (type, listener, ...args) {
      if (type === 'characteristicvaluechanged' && isBondedButtonless(this)) {
        removeResponseHandler(this, listener);
      }
      return originalRemoveEventListener.call(this, type, listener, ...args);
    };
  }

  const guardWrite = original => async function (...args) {
    if (isBondedButtonless(this)) {
      const device = this.service?.device;
      if (!device || !verifiedDevices.has(device)) {
        signalBlockedDfuWrite(this);
        throw unverifiedBondError();
      }
    }
    return original.apply(this, args);
  };

  if (typeof originalWriteWithResponse === 'function') {
    prototype.writeValueWithResponse = guardWrite(originalWriteWithResponse);
  }
  if (typeof originalWriteWithoutResponse === 'function') {
    prototype.writeValueWithoutResponse = guardWrite(originalWriteWithoutResponse);
  }
  if (typeof originalWriteValue === 'function') {
    prototype.writeValue = guardWrite(originalWriteValue);
  }

  return true;
}

// Backward-compatible export name used by earlier branch experiments.
export const installBondedDfuSecurityReset = installBondedDfuSecurityGuard;

installBondedDfuSecurityGuard();
