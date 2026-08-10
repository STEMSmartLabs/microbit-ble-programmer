import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { patchAppSourceForBondedDfuCompatibility } from '../app-compatibility-policy.js';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const patched = patchAppSourceForBondedDfuCompatibility(source, {
  baseUrl: new URL('../app-compatibility-policy.js', import.meta.url).href,
  version: '2.4.16',
});

test('classifies only the terminal bonded 0004 access failure', () => {
  assert.match(patched, /compatibilityError\.code = 'BONDED_DFU_ACCESS_UNAVAILABLE'/);
  assert.match(patched, /Could not enable bonded DFU indications after the one allowed reconnect/);
});

test('requires Android power cycle after Secure DFU authorization failure', () => {
  assert.match(patched, /androidAuthorizationRefreshRequired = true/);
  assert.match(patched, /Power the micro:bit off and on/);
  assert.match(patched, /pending program will NOT auto-resume/);
});

test('does not auto-resume recovery until normal application is detected', () => {
  assert.match(patched, /if \(androidAuthorizationRefreshRequired\)/);
  assert.match(patched, /Waiting for application/);
  assert.match(patched, /androidAuthorizationRefreshRequired = false/);
  assert.match(patched, /Normal application services are visible again/);
});

test('handles Android authorization failure after second DFU selection too', () => {
  assert.match(patched, /Android Secure DFU authorization was not restored after the second Bluetooth selection/);
  assert.match(patched, /pendingDfu = packageToFlash/);
});

test('retains proven transfer and general recovery policy', () => {
  assert.match(patched, /recoveryReconnectPending \? \[0, 1200\]/);
  assert.match(patched, /packetDelayMs: 4/);
  assert.match(patched, /objectDrainDelayMs: 150/);
  assert.match(patched, /runPartialFlashWithRecovery/);
});
