/**
 * Simplified Bluetooth programming workflow for v2.4.14.
 *
 * Proven transfer behavior is retained. v2.4.14 adds Android-only recovery
 * handling around Secure DFU authorization and the application-to-bootloader
 * GATT transition. macOS/desktop transfer timing remains unchanged.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.14';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.14';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.14';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.14';
import { installAndroidDfuTransitionPolicy } from './android-dfu-policy.js?v=2.4.14';
import { loadBondedDfuCompatibilityApp } from './app-compatibility-policy.js?v=2.4.14';

const HANDOFF_VERSION = '2.4.14';
const appVersion = document.getElementById('appVersion');
const buildLabel = document.getElementById('buildLabel');
const status = document.getElementById('status');
const progressText = document.getElementById('progressText');

if (appVersion) appVersion.textContent = `v${HANDOFF_VERSION}`;
if (buildLabel) buildLabel.textContent = `Build ${HANDOFF_VERSION}`;

installChecksumPacedFirmwareTransfer(NordicSecureDfu);
installFreshDfuChooserHandoff(NordicSecureDfu, {
  readinessDelayMs: 1800,
  connectionTimeoutMs: 7000,
});
installVerifiedDfuResume(NordicSecureDfu, {
  reconnectDelaysMs: [2000],
  connectionTimeoutMs: 7000,
});
installAndroidDfuTransitionPolicy(NordicSecureDfu, {
  applicationRediscoveryDelaysMs: [3000, 5000],
});

try {
  await loadBondedDfuCompatibilityApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal firmware transfer pacing is unchanged. Android Chrome now stops repeated recovery attempts on GATT authorization failure and asks for reset/pair/Connect, while an accepted DFU reboot gets an Android-only delayed live-service rediscovery before asking for another user action.`;
  }
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
