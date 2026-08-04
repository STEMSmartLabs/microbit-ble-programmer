/**
 * Automatic Secure DFU handoff layered on top of the proven v2.2.9 app.
 *
 * The first DFU-device request after the Buttonless DFU disconnect reuses the
 * already permitted application BluetoothDevice. This avoids ambiguity when
 * several nearby micro:bits advertise as DfuTarg. If that automatic attempt
 * fails, later clicks use the normal browser chooser as a manual fallback.
 */
const HANDOFF_VERSION = '2.3.0';
const bluetooth = navigator.bluetooth;
const originalRequestDevice = bluetooth?.requestDevice?.bind(bluetooth);
let targetMicrobit = null;
let automaticRequestArmed = false;
let selectorWasReady = false;

function isApplicationRequest(options = {}) {
  return Array.isArray(options.filters)
    && options.filters.some(filter => filter?.namePrefix === 'BBC micro:bit');
}

function isDfuRequest(options = {}) {
  const services = options.optionalServices || [];
  return options.acceptAllDevices === true
    && services.some(service => String(service).toLowerCase() === '65113'
      || String(service).toLowerCase() === '0xfe59'
      || String(service).toLowerCase() === 'fe59');
}

if (bluetooth && originalRequestDevice) {
  bluetooth.requestDevice = async options => {
    if (isDfuRequest(options) && automaticRequestArmed && targetMicrobit) {
      automaticRequestArmed = false;
      return targetMicrobit;
    }

    const selected = await originalRequestDevice(options);
    if (isApplicationRequest(options)) targetMicrobit = selected;
    return selected;
  };
}

function selectorReady(button) {
  return Boolean(button && !button.hidden && !button.disabled);
}

function watchDfuSelector() {
  const button = document.getElementById('selectDfu');
  if (!button) return;

  const evaluate = () => {
    const ready = selectorReady(button);
    if (ready && !selectorWasReady && targetMicrobit) {
      selectorWasReady = true;
      automaticRequestArmed = true;
      button.textContent = 'Connecting to rebooted micro:bit…';
      queueMicrotask(() => button.click());
    } else if (!ready) {
      selectorWasReady = false;
    }
  };

  new MutationObserver(evaluate).observe(button, {
    attributes: true,
    attributeFilter: ['hidden', 'disabled'],
  });
  evaluate();
}

await import('./app.js?v=2.2.9');

const appVersion = document.getElementById('appVersion');
const buildLabel = document.getElementById('buildLabel');
if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;
watchDfuSelector();
