/**
 * Secure DFU handoff for v2.4.8.
 *
 * DFU entry remains the proven v2.4.7 Nordic bonded flow. Partial flashing is
 * unchanged. The transfer layer adds first-firmware-object stabilization only:
 * a short settle delay, slower packet pacing for object 0, and a longer drain
 * before CRC validation. Later objects keep the existing fast checksum-paced
 * transfer policy.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.8';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.8';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.8';
import { loadRuntimeIndependentDfuApp } from './app-dfu-entry-policy.js?v=2.4.8';

const HANDOFF_VERSION = '2.4.8';
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
  status.textContent += `\nDFU v${HANDOFF_VERSION}: v2.4.7 Nordic bonded entry retained; first firmware object stabilized with extra settle/drain and 15 ms pacing; later objects retain fast checksum-paced transfer.`;
}
watchDfuSelector();
