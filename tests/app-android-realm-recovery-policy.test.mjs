import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { patchAppSourceForAndroidRealmRecovery } from '../app-android-realm-recovery-policy.js';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const policySource = fs.readFileSync(new URL('../app-android-realm-recovery-policy.js', import.meta.url), 'utf8');
const patched = patchAppSourceForAndroidRealmRecovery(source, {
  baseUrl: new URL('../app-android-realm-recovery-policy.js', import.meta.url).href,
  version: '2.4.20',
});

test('full source patch initializes and returns JavaScript source', () => {
  assert.equal(typeof patched, 'string');
  assert.ok(patched.length > source.length);
  assert.doesNotMatch(policySource, /patched\.replaceOnce\s*\(/);
});

test('page refresh fallback is limited to exhausted confirmed Android transition', () => {
  assert.match(patched, /ANDROID_DFU_TRANSITION_STALE/);
  assert.match(patched, /androidDfuRebootConfirmed = true/);
  assert.match(patched, /persistAndroidDfuRealmRecovery\(packageToFlash\)/);
  assert.match(patched, /location\.reload\(\)/);
  assert.match(patched, /androidDfuRealmRefreshUsed/);
});

test('pending init packet and firmware survive one page refresh', () => {
  assert.match(patched, /ANDROID_DFU_REALM_RECOVERY_KEY/);
  assert.match(patched, /bytesToSessionBase64/);
  assert.match(patched, /sessionBase64ToBytes/);
  assert.match(patched, /restoredAndroidDfuPackage/);
  assert.match(patched, /pendingDfu = restoredAndroidDfuPackage/);
});

test('restored page asks for Connect and can resume direct Secure DFU', () => {
  assert.match(patched, /Android Bluetooth refreshed — press Connect once/);
  assert.match(patched, /recoveryReconnectPending = true/);
  assert.match(patched, /runDirectSecureDfuRecovery/);
  assert.match(patched, /classification\.mode === 'secure-dfu'/);
});

test('does not revoke Bluetooth permission or change proven transfer parameters', () => {
  assert.doesNotMatch(patched, /\.forget\s*\(/);
  assert.match(patched, /packetDelayMs: 4/);
  assert.match(patched, /objectDrainDelayMs: 150/);
  assert.match(patched, /runPartialFlashWithRecovery/);
});
