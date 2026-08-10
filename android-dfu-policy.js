const PATCH_FLAG = Symbol.for('stem.microbit.androidDfuTransitionV2414');
const ANDROID_DFU_AUTHORIZATION_REQUIRED = 'ANDROID_DFU_AUTHORIZATION_REQUIRED';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function isAndroidBrowser() {
  return /Android/i.test(String(globalThis.navigator?.userAgent || ''));
}

function tagAndroidAuthorizationError(error) {
  const text = String(error?.message || error || '');
  if (!/GATT operation not permitted/i.test(text)) return error;
  error.code = ANDROID_DFU_AUTHORIZATION_REQUIRED;
  return error;
}

export function installAndroidDfuTransitionPolicy(NordicSecureDfu, {
  applicationRediscoveryDelaysMs = [3000, 5000],
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
        throw tagAndroidAuthorizationError(error);
      }

      if (error?.code !== 'DFU_CANDIDATE_APPLICATION') throw error;

      let lastError = error;
      const delays = Array.isArray(applicationRediscoveryDelaysMs)
        ? applicationRediscoveryDelaysMs.map(value => Math.max(0, Number(value) || 0))
        : [3000, 5000];

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
            throw tagAndroidAuthorizationError(retryError);
          }
          if (retryError?.code !== 'DFU_CANDIDATE_APPLICATION') throw retryError;
          lastError = retryError;
        }
      }

      this.log(
        'Android still exposes the application Bluetooth service after the DFU transition grace period. '
        + 'Returning control to the normal Connect workflow.',
        'warn',
      );
      throw lastError;
    }
  };

  return true;
}

export { ANDROID_DFU_AUTHORIZATION_REQUIRED };
