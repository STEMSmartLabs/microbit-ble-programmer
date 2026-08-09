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
  return true;
}
`;

test('full DFU entry no longer depends on Partial Programming mode byte', () => {
  const patched = patchAppSourceForRuntimeIndependentDfu(legacySource, {
    baseUrl: 'https://program.example.test/',
    version: '2.4.5',
  });

  assert.match(patched, /const APP_VERSION = '2\.4\.5'/);
  assert.match(patched, /This no longer blocks full DFU/);
  assert.match(patched, /real bonded Buttonless DFU operation/);
  assert.doesNotMatch(
    patched,
    /throw new Error\('micro:bit did not enter pairing\/programming mode for bonded DFU'\)/,
  );
  assert.match(patched, /https:\/\/program\.example\.test\/dfu\.js\?v=2\.4\.5/);
});

test('source patch fails closed when the expected app function is absent', () => {
  assert.throws(
    () => patchAppSourceForRuntimeIndependentDfu("const APP_VERSION = '2.4.0';", {
      baseUrl: 'https://program.example.test/',
      version: '2.4.5',
    }),
    /ensurePairingModeForFullDfu/,
  );
});
