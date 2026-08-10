const PATCH_FLAG = Symbol.for('stem.microbit.androidDfuTransitionV2417');
const ANDROID_DFU_AUTHORIZATION_REQUIRED = 'ANDROID_DFU_AUTHORIZATION_REQUIRED';
const ANDROID_DFU_TRANSITION_STALE = 'ANDROID_DFU_TRANSITION_STALE';
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

function wrapAndroidTransitionStaleError(error) {
  const wrapped = new Error(
    'Android Bluetooth is still showing the previous application services after the confirmed DFU reboot',
  );
  wrapped.name = 'AndroidDfuTransitionStaleError';
  wrapped.code = ANDROID_DFU_TRANSITION_STALE;
  wrapped.cause = error;
  return wrapped;
}

export function installAndroidDfuTransitionPolicy(NordicSecureDfu, {
  // Do not hammer Android GATT while the same bonded micro:bit changes its
  // service database. Recent device logs show that repeated 5-second connects
  // keep returning the stale table. Use three long quiet periods instead. With
  // the common 1.8-second readiness delay, this allows roughly 50 seconds for
  // Android/Chrome to converge before asking for one fresh Connect.
  applicationRediscoveryDelaysMs = [10000, 15000, 20000],
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
        : [10000, 15000, 20000];

      for (let attempt = 0; attempt < delays.length; attempt++) {
        const delayMs = delays[attempt];
        this.log(
          'Android is still showing the previous application Bluetooth services after the confirmed DFU reboot. '
          + 'Leaving GATT disconnected and quiet for ' + (Math.round(delayMs / 100) / 10)
          + ' seconds before the next live-service check ('
          + (attempt + 1) + '/' + delays.length + ')…',
          'warn',
        );

        try { device?.gatt?.disconnect?.(); } catch {}
        if (delayMs) await sleep(delayMs);

        try {
          const result = await originalConnect.call(this, device);
          this.log('Android Bluetooth now exposes Secure DFU services; continuing automatically.');
          return result;
        } catch (retryError) {
          if (/GATT operation not permitted/i.test(String(retryError?.message || ''))) {
            throw wrapAndroidAuthorizationError(retryError);
          }
          if (retryError?.code !== 'DFU_CANDIDATE_APPLICATION') throw retryError;
          lastError = retryError;
        }
      }

      try { device?.gatt?.disconnect?.(); } catch {}
      this.log(
        'Android is still showing the previous application services after the quiet DFU transition window. '
        + 'A fresh browser Connect is required to refresh the selected Bluetooth identity.',
        'warn',
      );
      throw wrapAndroidTransitionStaleError(lastError);
    }
  };

  return true;
}

export { ANDROID_DFU_AUTHORIZATION_REQUIRED, ANDROID_DFU_TRANSITION_STALE };
