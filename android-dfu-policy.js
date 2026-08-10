const PATCH_FLAG = Symbol.for('stem.microbit.androidDfuTransitionV2416');
const ANDROID_DFU_AUTHORIZATION_REQUIRED = 'ANDROID_DFU_AUTHORIZATION_REQUIRED';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function isAndroidBrowser() {
  return /Android/i.test(String(globalThis.navigator?.userAgent || ''));
}

export function wrapAndroidAuthorizationError(error) {
  const text = String(error?.message || error || '');
  if (!/GATT operation not permitted/i.test(text)) return error;

  // DOMException.code is read-only in Android Chrome. Never mutate the browser
  // exception: wrap it in a normal Error whose application code is writable.
  const wrapped = new Error(text || 'GATT operation not permitted');
  wrapped.name = 'AndroidDfuAuthorizationError';
  wrapped.code = ANDROID_DFU_AUTHORIZATION_REQUIRED;
  wrapped.cause = error;
  return wrapped;
}

export function installAndroidDfuTransitionPolicy(NordicSecureDfu, {
  // Android Chrome can retain the application GATT table for tens of seconds
  // after the secured reboot is accepted. Together with the 1.8 s GATT-ready
  // delay in the common handoff policy, this sequence gives roughly a 40 s
  // transition window before returning control to the user.
  applicationRediscoveryDelaysMs = [3000, 5000, 5000, 5000, 5000, 5000],
} = {}) {
  const prototype = NordicSecureDfu?.prototype;
  if (!prototype || typeof prototype.connect !== 'function') return false;
  if (prototype[PATCH_FLAG]) return true;

  Object.defineProperty(prototype, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  const originalConnect = prototype.connect;

  prototype.connect = async function (device) {
    const android = isAndroidBrowser();

    try {
      return await originalConnect.call(this, device);
    } catch (error) {
      if (!android) throw error;

      if (/GATT operation not permitted/i.test(String(error?.message || ''))) {
        throw wrapAndroidAuthorizationError(error);
      }

      if (error?.code !== 'DFU_CANDIDATE_APPLICATION') throw error;

      let lastError = error;
      const delays = Array.isArray(applicationRediscoveryDelaysMs)
        ? applicationRediscoveryDelaysMs.map(value => Math.max(0, Number(value) || 0))
        : [3000, 5000, 5000, 5000, 5000, 5000];

      for (let attempt = 0; attempt < delays.length; attempt++) {
        const delayMs = delays[attempt];
        this.log(
          'Android is still showing the application Bluetooth service after the DFU reboot. '
          + 'Waiting ' + (Math.round(delayMs / 100) / 10)
          + ' seconds, then reconnecting the same selected micro:bit and rediscovering live services ('
          + (attempt + 1) + '/' + delays.length + ')…',
          'warn',
        );

        try { device?.gatt?.disconnect?.(); } catch {}
        if (delayMs) await sleep(delayMs);

        try {
          const result = await originalConnect.call(this, device);
          this.log('Android live services changed to Secure DFU; continuing automatically.');
          return result;
        } catch (retryError) {
          if (/GATT operation not permitted/i.test(String(retryError?.message || ''))) {
            throw wrapAndroidAuthorizationError(retryError);
          }
          if (retryError?.code !== 'DFU_CANDIDATE_APPLICATION') throw retryError;
          lastError = retryError;
        }
      }

      this.log(
        'Android still exposes the application Bluetooth service after the approximately 40-second DFU transition window. '
        + 'Returning control to the normal Connect workflow.',
        'warn',
      );
      throw lastError;
    }
  };

  return true;
}

export { ANDROID_DFU_AUTHORIZATION_REQUIRED };
