/**
 * Simplified Bluetooth programming workflow for v2.4.12.
 *
 * Proven transfer behavior is retained: v2.4.7 bonded DFU entry, v2.4.8
 * first-object stabilization, v2.4.9 verified-bootloader resume, v2.4.10
 * live-GATT classification and v2.4.11 Connect / Program / Disconnect workflow.
 * v2.4.12 changes only stranded-recovery behavior: one same-device resume
 * attempt, then reset-once + fresh Connect guidance while preserving the
 * prepared program package.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.12';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.12';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.12';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.12';
import { loadResetRecoveryApp } from './app-recovery-policy.js?v=2.4.12';

const HANDOFF_VERSION = '2.4.12';
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
  // The same Web Bluetooth DFU identity became repeatedly unusable in the
  // observed macOS failure. Try it once, then move to reset + fresh Connect.
  reconnectDelaysMs: [2000],
  connectionTimeoutMs: 7000,
});

try {
  await loadResetRecoveryApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal transfer pacing is unchanged. If an interrupted full-programming connection cannot recover once, press the micro:bit reset button once and then Connect; the app will classify the live state and either resume recovery or safely retry from the application.`;
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
