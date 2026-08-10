/**
 * Simplified Bluetooth programming workflow for v2.4.20.
 *
 * Proven DFU behavior remains unchanged. v2.4.20 adds one Android-only fallback:
 * if the confirmed DFU reboot is followed by the existing exhausted stale-GATT
 * transition window, preserve the pending DFU package, reload the page once to
 * create a fresh Web Bluetooth context, then resume from Secure DFU if visible.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.20';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.20';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.20';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.20';
import { installAndroidDfuTransitionPolicy } from './android-dfu-policy.js?v=2.4.20';
import { loadAndroidRealmRecoveryApp } from './app-android-realm-recovery-policy.js?v=2.4.20';

const HANDOFF_VERSION = '2.4.20';
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
  applicationRediscoveryDelaysMs: [10000, 15000, 20000],
});

try {
  await loadAndroidRealmRecoveryApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Existing DFU transfer and Android transition behavior is unchanged. Only if the confirmed DFU reboot still exposes stale application services after the normal 10/15/20-second transition checks, Android preserves the pending program, reloads this page once to recreate the Web Bluetooth context, then asks for one Connect to continue.`;
  }
} catch (error) {
  const message = error?.message || String(error);
  if (status) status.textContent += `\nERROR: v${HANDOFF_VERSION} initialization failed: ${message}`;
  if (progressText) progressText.textContent = `Initialization failed: ${message}`;
  console.error(`micro:bit Bluetooth Programmer v${HANDOFF_VERSION} initialization failed`, error);
}
