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

test('extends stale application-service rediscovery to 3s + 5s + 8s on Android', () => {
  assert.match(source, /applicationRediscoveryDelaysMs = \[3000, 5000, 8000\]/);
  assert.match(source, /Android live services changed to Secure DFU/);
  assert.match(source, /extended DFU transition grace period/);
});
