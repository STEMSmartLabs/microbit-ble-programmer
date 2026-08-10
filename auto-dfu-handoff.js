/**
 * Simplified Bluetooth programming workflow for v2.4.18.
 *
 * Proven transfer behavior is retained. v2.4.18 adds an Android-only confirmed
 * DFU reboot latch so stale 0004-only GATT views cannot be mistaken for a real
 * application return after opcode 0x01 was positively accepted. Genuine Secure
 * DFU 0001+0002 or a complete application view (partial + 0004) clears the latch.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.18';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.18';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.18';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.18';
import { installAndroidDfuTransitionPolicy } from './android-dfu-policy.js?v=2.4.18';
import { loadConfirmedDfuHandoffApp } from './app-confirmed-dfu-policy.js?v=2.4.18';

const HANDOFF_VERSION = '2.4.18';
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
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal firmware transfer pacing is unchanged. On Android, a positively accepted DFU reboot is now latched until Secure DFU 0001+0002 appears or the complete normal application service set returns. A stale 0004-only view preserves the pending program and will not trigger Buttonless DFU entry again.`;
  }
} catch (error) {
  const message = error?.message || String(error);
  if (status) status.textContent += `\nERROR: v${HANDOFF_VERSION} initialization failed: ${message}`;
  if (progressText) progressText.textContent = `Initialization failed: ${message}`;
  console.error(`micro:bit Bluetooth Programmer v${HANDOFF_VERSION} initialization failed`, error);
}
