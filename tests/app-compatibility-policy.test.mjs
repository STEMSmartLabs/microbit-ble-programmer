import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { patchAppSourceForBondedDfuCompatibility } from '../app-compatibility-policy.js';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const patched = patchAppSourceForBondedDfuCompatibility(source, {
  baseUrl: new URL('../app-compatibility-policy.js', import.meta.url).href,
  version: '2.4.14',
});

test('classifies only the terminal bonded 0004 access failure', () => {
  assert.match(patched, /compatibilityError\.code = 'BONDED_DFU_ACCESS_UNAVAILABLE'/);
  assert.match(patched, /Could not enable bonded DFU indications after the one allowed reconnect/);
  assert.match(patched, /Could not enable bonded DFU indications on 0004:/);
});

test('shows Android reset-pair-connect guidance for Secure DFU authorization failure', () => {
  assert.match(patched, /ANDROID_DFU_AUTHORIZATION_REQUIRED/);
  assert.match(patched, /Press reset once, pair if asked, then Connect/);
  assert.match(patched, /Android recovery/);
});

test('keeps one-time USB guidance for application-side protected 0004 incompatibility', () => {
  assert.match(patched, /USB setup required once/);
  assert.match(patched, /Use USB once to install the approved Bluetooth base program/);
  assert.match(patched, /Bluetooth setup unsupported/);
});

test('retains proven transfer and reset recovery policy', () => {
  assert.match(patched, /recoveryReconnectPending \? \[0, 1200\]/);
  assert.match(patched, /packetDelayMs: 4/);
  assert.match(patched, /objectDrainDelayMs: 150/);
  assert.match(patched, /runPartialFlashWithRecovery/);
});
