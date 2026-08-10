/**
 * Simplified Bluetooth programming workflow for v2.4.19.
 *
 * Proven transfer behavior is retained. v2.4.19 fixes only an initialization
 * typo in the confirmed-DFU handoff source patch. The v2.4.18 Android state
 * machine behavior is otherwise unchanged.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.19';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.19';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.19';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.19';
import { installAndroidDfuTransitionPolicy } from './android-dfu-policy.js?v=2.4.19';
import { loadConfirmedDfuHandoffApp } from './app-confirmed-dfu-policy.js?v=2.4.19';

const HANDOFF_VERSION = '2.4.19';
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
  await loadConfirmedDfuHandoffApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal firmware transfer pacing is unchanged. The confirmed Android DFU handoff state from v2.4.18 is active; v2.4.19 fixes the source-patch initialization typo only.`;
  }
} catch (error) {
  const message = error?.message || String(error);
  if (status) status.textContent += `\nERROR: v${HANDOFF_VERSION} initialization failed: ${message}`;
  if (progressText) progressText.textContent = `Initialization failed: ${message}`;
  console.error(`micro:bit Bluetooth Programmer v${HANDOFF_VERSION} initialization failed`, error);
}
