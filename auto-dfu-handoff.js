/**
 * Simplified Bluetooth programming workflow for v2.4.16.
 *
 * Proven transfer behavior is retained. v2.4.16 adds an Android-only
 * authorization-refresh gate: after protected Secure DFU responses are denied,
 * recovery mode cannot auto-resume until the normal application is seen again
 * after a power cycle. The Android application-to-bootloader transition also
 * gets an approximately 40-second live-service rediscovery window.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.16';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.16';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.16';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.16';
import { installAndroidDfuTransitionPolicy } from './android-dfu-policy.js?v=2.4.16';
import { loadBondedDfuCompatibilityApp } from './app-compatibility-policy.js?v=2.4.16';

const HANDOFF_VERSION = '2.4.16';
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
  applicationRediscoveryDelaysMs: [3000, 5000, 5000, 5000, 5000, 5000],
});

try {
  await loadBondedDfuCompatibilityApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal firmware transfer pacing is unchanged. On Android, protected Secure DFU authorization failure now requires a power cycle and a verified return to normal application services before recovery can continue; accepted DFU reboot transitions are automatically rediscovered for about 40 seconds.`;
  }
} catch (error) {
  const message = error?.message || String(error);
  if (status) status.textContent += `\nERROR: v${HANDOFF_VERSION} initialization failed: ${message}`;
  if (progressText) progressText.textContent = `Initialization failed: ${message}`;
  console.error(`micro:bit Bluetooth Programmer v${HANDOFF_VERSION} initialization failed`, error);
}
