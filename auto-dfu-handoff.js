/**
 * Automatic Secure DFU handoff for v2.4.0.
 *
 * The original permitted BluetoothDevice is tried once after a possible or
 * confirmed DFU reboot. A failed GATT verification never re-arms the automatic
 * click. The normal browser chooser remains the manual fallback.
 */
import { AutomaticDfuHandoffState } from './handoff-state.js?v=2.4.0';

const HANDOFF_VERSION = '2.4.0';
const bluetooth = navigator.bluetooth;
const originalRequestDevice = bluetooth?.requestDevice?.bind(bluetooth);
const handoffState = new AutomaticDfuHandoffState();

let targetMicrobit = null;
let automaticRequestArmed = false;

function isApplicationRequest(options = {}) {
  return Array.isArray(options.filters)
    && options.filters.some(filter => filter?.namePrefix === 'BBC micro:bit');
}

function isDfuRequest(options = {}) {
  const services = options.optionalServices || [];
  return options.acceptAllDevices === true
    && services.some(service => {
      const value = String(service).toLowerCase();
      return value === '65113' || value === '0xfe59' || value === 'fe59';
    });
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

function watchDfuSelector() {
  const button = document.getElementById('selectDfu');
  if (!button) return;

  const evaluate = () => {
    const visible = !button.hidden;
    const enabled = visible && !button.disabled;
    const action = handoffState.evaluate({
      visible,
      enabled,
      hasTarget: Boolean(targetMicrobit),
    });

    if (action === 'idle') {
      automaticRequestArmed = false;
      button.textContent = 'Select DfuTarg manually';
      return;
    }

    if (action === 'waiting') {
      button.textContent = 'Waiting for DFU handoff…';
      return;
    }

    if (action === 'start-auto') {
      automaticRequestArmed = true;
      button.textContent = 'Checking the rebooted micro:bit once…';
      queueMicrotask(() => {
        if (!button.hidden && !button.disabled && automaticRequestArmed) {
          button.click();
        }
      });
      return;
    }

    if (action === 'auto-running') {
      button.textContent = 'Checking rebooted micro:bit…';
      return;
    }

    automaticRequestArmed = false;
    button.textContent = 'Select DfuTarg manually';
  };

  new MutationObserver(evaluate).observe(button, {
    attributes: true,
    attributeFilter: ['hidden', 'disabled'],
  });
  evaluate();
}

await import('./app.js?v=2.4.0');

const appVersion = document.getElementById('appVersion');
const buildLabel = document.getElementById('buildLabel');
const status = document.getElementById('status');
if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;
if (status) {
  status.textContent += `\nDFU entry state machine v${HANDOFF_VERSION}: bond verification, strict command outcome, one automatic target check.`;
}
watchDfuSelector();
