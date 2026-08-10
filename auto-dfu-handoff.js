/**
 * Simplified Bluetooth programming workflow for v2.4.17.
 *
 * Proven transfer behavior is retained. v2.4.17 changes only Android recovery
 * timing/state handling: one power cycle after protected Secure DFU authorization
 * failure, followed by quiet GATT refresh windows; and fewer, longer quiet
 * application-to-bootloader service rediscovery checks after opcode 0x01.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.17';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.17';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.17';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.17';
import { installAndroidDfuTransitionPolicy } from './android-dfu-policy.js?v=2.4.17';
import { loadBondedDfuCompatibilityApp } from './app-compatibility-policy.js?v=2.4.17';

const HANDOFF_VERSION = '2.4.17';
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
  await loadBondedDfuCompatibilityApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal firmware transfer pacing is unchanged. On Android, protected Secure DFU authorization failure now asks for one power cycle only, then Connect leaves GATT quiet and rechecks application services after 10 s, 15 s and 20 s. After a confirmed DFU reboot, Android uses the same longer quiet-service refresh pattern instead of frequent reconnects.`;
  }
} catch (error) {
  const message = error?.message || String(error);
  if (status) status.textContent += `\nERROR: v${HANDOFF_VERSION} initialization failed: ${message}`;
  if (progressText) progressText.textContent = `Initialization failed: ${message}`;
  console.error(`micro:bit Bluetooth Programmer v${HANDOFF_VERSION} initialization failed`, error);
}
