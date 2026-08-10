import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../android-dfu-policy.js', import.meta.url), 'utf8');

test('Android policy is gated by Android user agent', () => {
  assert.match(source, /\/Android\/i/);
  assert.match(source, /if \(!android\) throw error/);
});

test('classifies GATT operation not permitted as Android authorization recovery', () => {
  assert.match(source, /ANDROID_DFU_AUTHORIZATION_REQUIRED/);
  assert.match(source, /GATT operation not permitted/);
});

test('retries stale application service with delayed rediscovery only on Android', () => {
  assert.match(source, /DFU_CANDIDATE_APPLICATION/);
  assert.match(source, /applicationRediscoveryDelaysMs = \[3000, 5000\]/);
  assert.match(source, /Android live services changed to Secure DFU/);
});
