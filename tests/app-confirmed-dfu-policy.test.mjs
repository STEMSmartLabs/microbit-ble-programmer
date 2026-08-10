import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { patchAppSourceForConfirmedDfuHandoff } from '../app-confirmed-dfu-policy.js';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const patched = patchAppSourceForConfirmedDfuHandoff(source, {
  baseUrl: new URL('../app-confirmed-dfu-policy.js', import.meta.url).href,
  version: '2.4.18',
});

test('latches a positively confirmed Android DFU reboot', () => {
  assert.match(patched, /let androidDfuRebootConfirmed = false/);
  assert.match(patched, /androidDfuRebootConfirmed = \/Android\/i\.test/);
  assert.match(patched, /entryResult === 'confirmed'/);
});

test('0004-only cannot clear a confirmed Android DFU reboot', () => {
  assert.match(patched, /androidCompleteApplicationView = Boolean\(partialCharacteristic && buttonlessAvailable\)/);
  assert.match(patched, /\(androidDfuRebootConfirmed \|\| androidAuthorizationRefreshRequired\)/);
  assert.match(patched, /!androidCompleteApplicationView/);
  assert.match(patched, /Buttonless DFU 0004 will NOT be used again/);
  assert.match(patched, /pending program is preserved/);
});

test('complete application view requires partial programming plus buttonless 0004', () => {
  assert.match(patched, /refreshed\?\.mode === 'application'/);
  assert.match(patched, /&& partialCharacteristic/);
  assert.match(patched, /&& buttonlessAvailable/);
  assert.match(patched, /complete application service view \(Partial Programming \+ full programming\)/);
});

test('genuine Secure DFU clears the confirmed reboot latch', () => {
  assert.match(patched, /classification\.mode === 'secure-dfu'/);
  assert.match(patched, /Secure DFU control 0001 and packet 0002 are now visible/);
  assert.match(patched, /androidDfuRebootConfirmed = false/);
});

test('stale post-opcode transition preserves confirmed state and pending package', () => {
  assert.match(patched, /ANDROID_DFU_TRANSITION_STALE/);
  assert.match(patched, /androidDfuRebootConfirmed = true/);
  assert.match(patched, /pendingDfu = packageToFlash/);
  assert.match(patched, /Press Connect once to request a fresh Bluetooth view/);
});

test('proven DFU transport parameters remain unchanged', () => {
  assert.match(patched, /packetDelayMs: 4/);
  assert.match(patched, /objectDrainDelayMs: 150/);
  assert.match(patched, /runPartialFlashWithRecovery/);
});
