import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { patchAppSourceForSimplifiedWorkflow } from '../app-workflow-policy.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function patchedSource() {
  return patchAppSourceForSimplifiedWorkflow(appSource, {
    baseUrl: 'https://program.example.test/',
    version: '2.4.11',
  });
}

test('v2.4.11 exposes only Connect Program Disconnect in workflow state', () => {
  const patched = patchedSource();

  assert.match(patched, /const APP_VERSION = '2\.4\.11'/);
  assert.match(patched, /el\('selectDfu'\)\.hidden = true/);
  assert.match(patched, /el\('cancelDfu'\)\.hidden = true/);
  assert.match(patched, /el\('connect'\)\.textContent = recoveryReconnectPending \? 'Connect' : 'Connect'/);
  assert.match(patched, /el\('program'\)\.textContent = 'Program'/);
  assert.match(patched, /el\('disconnect'\)\.textContent = 'Disconnect'/);
});

test('Connect is serialized and automatically retries unstable initial GATT setup', () => {
  const patched = patchedSource();

  assert.match(patched, /let connectionInProgress = false/);
  assert.match(patched, /if \(connectionInProgress\) return/);
  assert.match(patched, /const retryDelays = \[0, 900, 1500, 2500\]/);
  assert.match(patched, /Bluetooth connection was not stable yet\. Reconnecting automatically/);
  assert.match(patched, /await sleep\(700\)/);
});

test('partial programming reconnects and restarts once after transient Bluetooth failure', () => {
  const patched = patchedSource();

  assert.match(patched, /async function runPartialFlashWithRecovery/);
  assert.match(patched, /if \(!isTransientBluetoothProgrammingError\(error\) \|\| partialRetryUsed\) throw error/);
  assert.match(patched, /partialRetryUsed = true/);
  assert.match(patched, /refreshed\.programMatches = false/);
  assert.match(patched, /await runPartialFlash\(refreshed\)/);
});

test('stranded bootloader stops repeated chooser loop and requires one fresh Connect selection', () => {
  const patched = patchedSource();

  assert.match(patched, /recoveryReconnectPending = true/);
  assert.match(patched, /applicationDevice = null/);
  assert.match(patched, /Bluetooth was interrupted — press Connect to continue/);
  assert.match(patched, /Press Connect once and select the micro:bit/);
  assert.match(patched, /if \(pendingDfu\) \{[\s\S]*Continuing automatically from the bootloader-reported offset and checksum/);
  assert.match(patched, /skipApproval: true/);
});

test('Program button owns the browser-required second Bluetooth chooser', () => {
  const patched = patchedSource();

  assert.match(patched, /if \(pendingDfu && dfuChooserReady\) \{\n    await selectDfuAndFlash\(\);/);
  assert.match(patched, /Press Program again and select the rebooted micro:bit/);
});
