import assert from 'node:assert/strict';
import test from 'node:test';

import { patchAppSourceForRuntimeIndependentDfu } from '../app-dfu-entry-policy.js';

const legacySource = `import {
  prepareFirmware,
} from './core.js';
import {
  NordicSecureDfu,
} from './dfu.js?v=2.4.0';
import { classifyDfuEntry } from './dfu-entry-state.js?v=2.4.0';

const APP_VERSION = '2.4.0';

async function ensurePairingModeForFullDfu(info) {
  if (!partialCharacteristic || info?.mode === 0) return info;
  const pairingInfo = await readFlashInfo(preparedFirmware);
  if (!pairingInfo || pairingInfo.mode !== 0) {
    throw new Error('micro:bit did not enter pairing/programming mode for bonded DFU');
  }
  return pairingInfo;
}

async function establishBondBeforeFullDfu() {
  const maxAuthorizationAttempts = 2;
  return { authorizationVerified: false, maxAuthorizationAttempts };
}

async function prepareAndEnterFullDfu(info, reason) {
  const bondResult = await establishBondBeforeFullDfu();
  setState('modeState', bondResult.authorizationVerified ? 'Bond verified' : 'Bond unverified', bondResult.authorizationVerified ? 'good' : 'warn');
  el('progressText').textContent = 'Sending one secured Buttonless DFU command';
  let outcome;
  outcome = await enterButtonlessDfu(applicationDevice, {
      log,
      skipAuthorization: true,
      authorizationVerified: bondResult.authorizationVerified,
  });
  return outcome;
}

async function program() {
  if (info?.runtimeMatches && info.layoutMatches) {
    await runPartialFlash(info);
    return;
  }
  await prepareAndEnterFullDfu(info, 'full DFU required');
}
`;

test('full DFU uses one direct secured transaction while partial selection stays intact', () => {
  const patched = patchAppSourceForRuntimeIndependentDfu(legacySource, {
    baseUrl: 'https://program.example.test/',
    version: '2.4.6',
  });

  assert.match(patched, /const APP_VERSION = '2\.4\.6'/);
  assert.match(patched, /Skipping separate 0004 notification authorization probes/);
  assert.match(patched, /one real secured Buttonless DFU write/);
  assert.match(patched, /timeoutMs: 6000/);
  assert.doesNotMatch(patched, /const maxAuthorizationAttempts = 2/);
  assert.doesNotMatch(
    patched,
    /throw new Error\('micro:bit did not enter pairing\/programming mode for bonded DFU'\)/,
  );
  assert.match(patched, /if \(info\?\.runtimeMatches && info\.layoutMatches\)/);
  assert.match(patched, /await runPartialFlash\(info\)/);
  assert.match(patched, /https:\/\/program\.example\.test\/dfu\.js\?v=2\.4\.6/);
});

test('source patch fails closed when the expected app function is absent', () => {
  assert.throws(
    () => patchAppSourceForRuntimeIndependentDfu("const APP_VERSION = '2.4.0';", {
      baseUrl: 'https://program.example.test/',
      version: '2.4.6',
    }),
    /full-DFU pairing preparation/,
  );
});
