import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { patchAppSourceForResetRecovery } from '../app-recovery-policy.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function patchedSource() {
  return patchAppSourceForResetRecovery(appSource, {
    baseUrl: 'https://program.example.test/',
    version: '2.4.12',
  });
}

test('v2.4.12 keeps proven DFU transport settings unchanged', () => {
  const patched = patchedSource();

  assert.match(patched, /packetDelayMs: 4/);
  assert.match(patched, /objectDrainDelayMs: 150/);
  assert.doesNotMatch(patched, /packetDelayMs: 12/);
  assert.doesNotMatch(patched, /objectDrainDelayMs: 300/);
});

test('failed interrupted-program Connect becomes reset-once recovery guidance', () => {
  const patched = patchedSource();

  assert.match(patched, /recoveryReconnectPending \? \[0, 1200\] : \[0, 900, 1500, 2500\]/);
  assert.match(patched, /Press the micro:bit reset button once, then press Connect/);
  assert.match(patched, /If it returns to recovery mode, programming will resume automatically/);
  assert.match(patched, /if it returns to the application, Program will safely start the full update again/);
});

test('successful live GATT classification clears recovery failure state', () => {
  const patched = patchedSource();

  assert.match(patched, /if \(classification\.mode === 'secure-dfu'\) \{\n      recoveryConnectFailures = 0;/);
  assert.match(patched, /else \{\n      recoveryConnectFailures = 0;\n      if \(pendingDfu \|\| recoveryReconnectPending\)/);
});
