/**
 * Secure DFU handoff for v2.4.5.
 *
 * Runtime mode and pre-authorization are best-effort only. The actual secured
 * Buttonless DFU write/reboot outcome decides whether the app proceeds. After
 * reboot, Continue always opens a fresh Web Bluetooth chooser.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.5';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.5';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.5';
import { loadRuntimeIndependentDfuApp } from './app-dfu-entry-policy.js?v=2.4.5';

const HANDOFF_VERSION = '2.4.5';
installChecksumPacedFirmwareTransfer(NordicSecureDfu);
installFreshDfuChooserHandoff(NordicSecureDfu, {
  readinessDelayMs: 1800,
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

await loadRuntimeIndependentDfuApp({ version: HANDOFF_VERSION });

const appVersion = document.getElementById('appVersion');
const buildLabel = document.getElementById('buildLabel');
const status = document.getElementById('status');
if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;
if (status) {
  status.textContent += `\nDFU v${HANDOFF_VERSION}: runtime-independent DFU entry; real secured 0004 write is always attempted when available; fresh chooser handoff; checksum-paced firmware transfer.`;
}
watchDfuSelector();
