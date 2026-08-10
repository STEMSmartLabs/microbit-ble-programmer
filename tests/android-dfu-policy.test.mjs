import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { wrapAndroidAuthorizationError } from '../android-dfu-policy.js';

const source = fs.readFileSync(new URL('../android-dfu-policy.js', import.meta.url), 'utf8');

test('Android policy is gated by Android user agent', () => {
  assert.match(source, /\/Android\/i/);
  assert.match(source, /if \(!android\) throw error/);
});

test('wraps read-only browser GATT authorization errors instead of mutating DOMException', () => {
  const browserError = Object.freeze({ message: 'GATT operation not permitted', code: 0 });
  const wrapped = wrapAndroidAuthorizationError(browserError);
  assert.notEqual(wrapped, browserError);
  assert.equal(wrapped.message, 'GATT operation not permitted');
  assert.equal(wrapped.code, 'ANDROID_DFU_AUTHORIZATION_REQUIRED');
  assert.equal(wrapped.cause, browserError);
  assert.doesNotMatch(source, /error\.code = ANDROID_DFU_AUTHORIZATION_REQUIRED/);
});

test('uses long quiet application-to-DFU refresh windows on Android', () => {
  assert.match(source, /applicationRediscoveryDelaysMs = \[10000, 15000, 20000\]/);
  assert.match(source, /Leaving GATT disconnected and quiet/);
  assert.match(source, /roughly 50 seconds/);
  assert.match(source, /Android Bluetooth now exposes Secure DFU services/);
});

test('classifies stale post-opcode Android services separately from real application mode', () => {
  assert.match(source, /ANDROID_DFU_TRANSITION_STALE/);
  assert.match(source, /previous application services after the confirmed DFU reboot/);
  assert.match(source, /fresh browser Connect/);
});
