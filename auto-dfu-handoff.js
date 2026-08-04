/**
 * Automatic Secure DFU handoff layered on top of the proven v2.2.9 app.
 *
 * One automatic connection attempt reuses the already permitted application
 * BluetoothDevice. If it still exposes application Buttonless DFU (0004), or
 * otherwise fails, automatic handoff stops and the normal manual DfuTarg
 * chooser remains available. The automatic attempt is reset only when the
 * pending DFU handoff is cancelled, completed, or otherwise hidden.
 */
import { AutomaticDfuHandoffState } from './handoff-state.js?v=2.3.1';

const HANDOFF_VERSION = '2.3.1';
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
      // Consume the automatic permission reuse exactly once. Any later DFU
      // request in this handoff must open the real browser chooser.
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
      button.textContent = 'Connecting to rebooted micro:bit once…';

      // The app deliberately enables this button only after the application
      // disconnect. Trigger one click; subsequent disabled/enabled transitions
      // during the connection attempt must never re-arm another automatic click.
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

    // The one automatic attempt has completed or no original target is
    // available. Leave a normal user-gesture picker as the only next action.
    automaticRequestArmed = false;
    button.textContent = 'Select DfuTarg manually';
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
const status = document.getElementById('status');
if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;
if (status) {
  status.textContent += `\nAutomatic DFU handoff layer v${HANDOFF_VERSION}: one automatic target attempt, then manual fallback.`;
}
watchDfuSelector();
