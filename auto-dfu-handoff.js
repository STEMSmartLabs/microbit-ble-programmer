/**
 * Secure DFU handoff for v2.4.6.
 *
 * Partial flashing remains unchanged. When full DFU is required, pairing mode
 * is prepared once, then the app performs one real secured Buttonless DFU write
 * without separate 0004 notification authorization probes. After reboot,
 * Continue opens a fresh Web Bluetooth chooser.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.6';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.6';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.6';
import { loadRuntimeIndependentDfuApp } from './app-dfu-entry-policy.js?v=2.4.6';

const HANDOFF_VERSION = '2.4.6';
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
  status.textContent += `\nDFU v${HANDOFF_VERSION}: partial path unchanged; one pairing preparation; no separate 0004 notification authorization probes; one real secured reboot write; fresh chooser handoff; checksum-paced firmware transfer.`;
}
watchDfuSelector();
