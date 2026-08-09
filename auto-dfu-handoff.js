/**
 * Secure DFU handoff for v2.4.9.
 *
 * DFU entry remains the proven v2.4.7 Nordic bonded flow and partial flashing
 * remains unchanged. v2.4.8 first-object stabilization is retained. v2.4.9
 * adds verified-bootloader recovery: after Secure DFU control 0001 and packet
 * 0002 have been positively verified, transient transport failures reconnect
 * the same BluetoothDevice and resume from bootloader-reported offset + CRC.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.9';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.9';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.9';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.9';
import { loadRuntimeIndependentDfuApp } from './app-dfu-entry-policy.js?v=2.4.9';

const HANDOFF_VERSION = '2.4.9';
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

await loadRuntimeIndependentDfuApp({ version: HANDOFF_VERSION });

const appVersion = document.getElementById('appVersion');
const buildLabel = document.getElementById('buildLabel');
const status = document.getElementById('status');
if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;
if (status) {
  status.textContent += `\nDFU v${HANDOFF_VERSION}: v2.4.7 bonded entry retained; v2.4.8 first-object stabilization retained; verified Secure DFU bootloader transport now reconnects and resumes automatically from bootloader offset + CRC after transient GATT failures.`;
}
watchDfuSelector();
