/**
 * Secure DFU handoff for v2.4.4.
 *
 * After the bonded Buttonless DFU command is accepted, the user presses
 * Continue. That click opens the real Web Bluetooth chooser so Chrome performs
 * a fresh scan for the rebooted Secure DFU identity. The old application
 * BluetoothDevice is never substituted for the chooser result.
 */
import './bluetooth-security-reset.js?v=2.4.4';
import { NordicSecureDfu } from './dfu.js?v=2.4.4';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.4';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.4';

const HANDOFF_VERSION = '2.4.4';
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
    button.textContent = button.disabled
      ? 'Preparing DFU…'
      : 'Continue';
  };

  new MutationObserver(updateLabel).observe(button, {
    attributes: true,
    attributeFilter: ['hidden', 'disabled'],
  });
  updateLabel();
}

await import('./app.js?v=2.4.4');

const appVersion = document.getElementById('appVersion');
const buildLabel = document.getElementById('buildLabel');
const status = document.getElementById('status');
if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;
if (status) {
  const normalizeVisibleVersion = () => {
    const normalized = status.textContent.replace(
      /STEM Smart Labs Bluetooth Programmer v[0-9.]+/g,
      `STEM Smart Labs Bluetooth Programmer v${HANDOFF_VERSION}`,
    );
    if (normalized !== status.textContent) status.textContent = normalized;
  };
  normalizeVisibleVersion();
  new MutationObserver(normalizeVisibleVersion).observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  status.textContent += `\nDFU v${HANDOFF_VERSION}: fresh chooser handoff, one short GATT attempt per selection, firmware PRNs disabled, checksum-paced data objects.`;
}
watchDfuSelector();
