/**
 * Secure DFU handoff for v2.4.10.
 *
 * v2.4.7 Nordic bonded DFU entry is retained. v2.4.8 first-object
 * stabilization and v2.4.9 verified-bootloader resume are retained. v2.4.10
 * classifies the selected device from its live connected GATT table instead of
 * trusting the cached Bluetooth name, allowing stale DfuTarg application
 * identities and direct recovery when the micro:bit is already in Secure DFU.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.10';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.10';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.10';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.10';
import { loadLiveGattDeviceStateApp } from './app-device-state-policy.js?v=2.4.10';

const HANDOFF_VERSION = '2.4.10';
const appVersion = document.getElementById('appVersion');
const buildLabel = document.getElementById('buildLabel');
const status = document.getElementById('status');
const progressText = document.getElementById('progressText');

// Set the visible build immediately. If a later initialization step fails, the
// page still reports the code version that was actually requested.
if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;

installChecksumPacedFirmwareTransfer(NordicSecureDfu);
installFreshDfuChooserHandoff(NordicSecureDfu, {
  readinessDelayMs: 1800,
  connectionTimeoutMs: 7000,
});
installVerifiedDfuResume(NordicSecureDfu, {
  reconnectDelaysMs: [2000, 3000, 5000],
  connectionTimeoutMs: 7000,
});

function watchDfuSelector() {
  const button = document.getElementById('selectDfu');
  if (!button) return;

  const updateLabel = () => {
    if (button.hidden) return;
    button.textContent = button.disabled ? 'Preparing DFU…' : 'Continue';
  };

  new MutationObserver(updateLabel).observe(button, {
    attributes: true,
    attributeFilter: ['hidden', 'disabled'],
  });
  updateLabel();
}

try {
  await loadLiveGattDeviceStateApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nDFU v${HANDOFF_VERSION}: live GATT services now decide application vs Secure DFU state. Stale DfuTarg names can connect as normal applications, and an already-running Secure DFU bootloader can be recovered directly with the selected HEX.`;
  }
  watchDfuSelector();
} catch (error) {
  const message = error?.message || String(error);
  if (status) {
    status.textContent += `\nERROR: v${HANDOFF_VERSION} initialization failed: ${message}`;
  }
  if (progressText) {
    progressText.textContent = `Initialization failed: ${message}`;
  }
  console.error(`micro:bit Bluetooth Programmer v${HANDOFF_VERSION} initialization failed`, error);
}
