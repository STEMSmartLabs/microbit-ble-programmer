// Branch-only DFU entry policy for macOS/Chrome testing.
//
// app.js currently performs up to two calls to authorizeBondedButtonlessDfu().
// A first secured CCCD/startNotifications failure is useful because it asks the
// host Bluetooth stack to establish or repair security. Repeating the same
// protected CCCD operation immediately after reconnect has repeatedly failed on
// macOS and leaves the link in the same state. After one unverified attempt,
// return an unverified result on the second call without touching the CCCD. The
// existing app then rediscovers services and sends the actual secured reboot
// command once on the fresh application link.

import * as base from './dfu.js?v=2.4.0-base';

export const DFU_SERVICE_UUID = base.DFU_SERVICE_UUID;
export const NordicSecureDfu = base.NordicSecureDfu;
export const discoverDfuService = base.discoverDfuService;
export const enterButtonlessDfu = base.enterButtonlessDfu;
export const requestDfuDevice = base.requestDfuDevice;

const firstUnverifiedAttempt = new WeakMap();

export async function authorizeBondedButtonlessDfu(device, options = {}) {
  if (firstUnverifiedAttempt.get(device)) {
    firstUnverifiedAttempt.delete(device);
    options.log?.(
      'A secured authorization attempt already failed on this host. Skipping a repeated notification authorization request and keeping the fresh connection for the single secured DFU command.',
      'warn',
    );
    return {
      bonded: true,
      verified: false,
      disconnected: false,
      notificationsStarted: false,
      error: new Error('Repeated bonded authorization intentionally skipped after the first GATT failure'),
    };
  }

  const result = await base.authorizeBondedButtonlessDfu(device, options);
  if (result?.verified) {
    firstUnverifiedAttempt.delete(device);
  } else {
    firstUnverifiedAttempt.set(device, true);
  }
  return result;
}
