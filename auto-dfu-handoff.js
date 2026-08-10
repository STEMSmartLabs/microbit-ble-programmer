/**
 * Simplified Bluetooth programming workflow for v2.4.15.
 *
 * Proven transfer behavior is retained. v2.4.15 fixes Android Chrome recovery
 * classification without mutating DOMException, extends the Android-only
 * application-to-bootloader rediscovery window, and routes protected Secure
 * DFU authorization failure directly to reset/pair/Connect guidance.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.15';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.15';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.15';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.15';
import { installAndroidDfuTransitionPolicy } from './android-dfu-policy.js?v=2.4.15';
import { loadBondedDfuCompatibilityApp } from './app-compatibility-policy.js?v=2.4.15';

const HANDOFF_VERSION = '2.4.15';
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
  applicationRediscoveryDelaysMs: [3000, 5000, 8000],
});

try {
  await loadBondedDfuCompatibilityApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal firmware transfer pacing is unchanged. Android Chrome now wraps read-only browser GATT errors safely, stops repeated recovery-mode authorization retries after the first protected DFU failure, and allows 3 s + 5 s + 8 s delayed rediscovery after an accepted DFU reboot.`;
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
