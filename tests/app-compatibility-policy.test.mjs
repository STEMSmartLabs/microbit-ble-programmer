import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { patchAppSourceForBondedDfuCompatibility } from '../app-compatibility-policy.js';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const patched = patchAppSourceForBondedDfuCompatibility(source, {
  baseUrl: new URL('../app-compatibility-policy.js', import.meta.url).href,
  version: '2.4.17',
});

test('classifies only the terminal bonded 0004 access failure', () => {
  assert.match(patched, /compatibilityError\.code = 'BONDED_DFU_ACCESS_UNAVAILABLE'/);
  assert.match(patched, /Could not enable bonded DFU indications after the one allowed reconnect/);
});

test('asks for one Android power cycle after Secure DFU authorization failure', () => {
  assert.match(patched, /androidAuthorizationRefreshRequired = true/);
  assert.match(patched, /Power the micro:bit off and on once/);
  assert.match(patched, /do not repeat the power cycle/);
});

test('single Connect performs quiet Android application-service refresh', () => {
  assert.match(patched, /const androidRefreshDelays = \[10000, 15000, 20000\]/);
  assert.match(patched, /Leaving Android GATT quiet/);
  assert.match(patched, /Waiting for Android Bluetooth to refresh/);
  assert.match(patched, /do not power-cycle again/);
});

test('clears authorization gate only after application services become visible', () => {
  assert.match(patched, /refreshed\?\.mode === 'application'/);
  assert.match(patched, /androidAuthorizationRefreshRequired = false/);
  assert.match(patched, /Bluetooth refreshed — press Program/);
});

test('preserves pending package when post-opcode Android service table stays stale', () => {
  assert.match(patched, /ANDROID_DFU_TRANSITION_STALE/);
  assert.match(patched, /pendingDfu = packageToFlash/);
  assert.match(patched, /press Connect once to request a fresh Bluetooth view/i);
});

test('retains proven transfer and general recovery policy', () => {
  assert.match(patched, /recoveryReconnectPending \? \[0, 1200\]/);
  assert.match(patched, /packetDelayMs: 4/);
  assert.match(patched, /objectDrainDelayMs: 150/);
  assert.match(patched, /runPartialFlashWithRecovery/);
});
