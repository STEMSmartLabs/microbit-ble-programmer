/**
 * Simplified Bluetooth programming workflow for v2.4.13.
 *
 * Proven behavior is retained: v2.4.7 bonded DFU entry, v2.4.8 first-object
 * stabilization, v2.4.9 verified-bootloader resume, v2.4.10 live-GATT
 * classification, v2.4.11 Connect / Program / Disconnect workflow and
 * v2.4.12 reset-once recovery. v2.4.13 adds only one compatibility classifier:
 * if protected bonded 0004 access still fails after the allowed security
 * restart + reconnect, stop the wireless retry loop and recommend one USB
 * provisioning flash of the approved Bluetooth base program.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.13';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.13';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.13';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.13';
import { loadBondedDfuCompatibilityApp } from './app-compatibility-policy.js?v=2.4.13';

const HANDOFF_VERSION = '2.4.13';
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

try {
  await loadBondedDfuCompatibilityApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: Connect / Program / Disconnect workflow active. Normal transfer pacing and reset-once recovery are unchanged. If protected Bluetooth full-programming access still fails after the allowed pairing/security restart and reconnect, the app stops wireless retries and recommends one USB setup flash of the approved Bluetooth base program.`;
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
