/**
 * Simplified Bluetooth programming workflow for v2.4.11.
 *
 * v2.4.7 bonded DFU entry, v2.4.8 first-object stabilization, v2.4.9
 * verified-bootloader resume and v2.4.10 live-GATT device classification are
 * retained. v2.4.11 simplifies the customer flow to Connect / Program /
 * Disconnect and adds automatic application reconnect, one safe partial-flash
 * restart, and fresh-identity recovery after a stranded Secure DFU connection.
 */
import { NordicSecureDfu } from './dfu.js?v=2.4.11';
import { installChecksumPacedFirmwareTransfer } from './dfu-transfer-policy.js?v=2.4.11';
import { installFreshDfuChooserHandoff } from './dfu-handoff-policy.js?v=2.4.11';
import { installVerifiedDfuResume } from './dfu-resume-policy.js?v=2.4.11';
import { loadSimplifiedWorkflowApp } from './app-workflow-policy.js?v=2.4.11';

const HANDOFF_VERSION = '2.4.11';
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
  reconnectDelaysMs: [2000, 3000, 5000],
  connectionTimeoutMs: 7000,
});

try {
  await loadSimplifiedWorkflowApp({ version: HANDOFF_VERSION });
  if (status) {
    status.textContent += `\nv${HANDOFF_VERSION}: simplified Connect / Program / Disconnect workflow active. Transient application disconnects reconnect automatically, one partial transfer restart is allowed, and stranded Secure DFU recovery uses a fresh Connect selection instead of repeated Continue attempts.`;
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
