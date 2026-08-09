/**
 * Secure DFU handoff for v2.4.7.
 *
 * Partial flashing remains unchanged. When full DFU is required, pairing mode
 * is prepared once, bonded Buttonless DFU indications on characteristic 0004
 * are enabled as required by Nordic SDK14+ bond sharing, and opcode 0x01 is
 * sent next on that same secured connection. After reboot, Continue opens a
 * fresh Web Bluetooth chooser.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.7';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.7';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.7';
import { loadRuntimeIndependentDfuApp } from './app-dfu-entry-policy.js?v=2.4.7';

const HANDOFF_VERSION = '2.4.7';
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
  status.textContent += `\nDFU v${HANDOFF_VERSION}: partial path unchanged; Nordic bonded 0004 indications enabled before opcode 0x01; one reconnect only after pairing restart; fresh chooser handoff; checksum-paced firmware transfer.`;
}
watchDfuSelector();
