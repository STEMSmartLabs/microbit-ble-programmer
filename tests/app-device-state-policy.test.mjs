import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { patchAppSourceForLiveGattDeviceState } from '../app-device-state-policy.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function patchedSource() {
  return patchAppSourceForLiveGattDeviceState(appSource, {
    baseUrl: 'https://program.example.test/',
    version: '2.4.10',
  });
}

test('Connect accepts application, DfuTarg and advertised FE59 recovery identities but classifies by live GATT', () => {
  const patched = patchedSource();

  assert.match(patched, /const APP_VERSION = '2\.4\.10'/);
  assert.match(patched, /\{ namePrefix: 'BBC micro:bit' \}/);
  assert.match(patched, /\{ namePrefix: 'DfuTarg' \}/);
  assert.match(patched, /\{ services: \[DFU_SERVICE_UUID\] \}/);
  assert.match(patched, /let secureDfuAvailable = false/);
  assert.match(patched, /secureCharacteristicsAvailable = Boolean\(dfu\?\.control && dfu\?\.packet\)/);
  assert.match(patched, /applicationServicesAvailable = Boolean\(partialCharacteristic \|\| buttonlessAvailable\)/);
  assert.match(patched, /secureDfuAvailable = secureCharacteristicsAvailable && !applicationServicesAvailable/);
  assert.match(patched, /Bluetooth name is stale \(DfuTarg\), but live application services were verified/);
});

test('Program directly recovers an already verified Secure DFU bootloader', () => {
  const patched = patchedSource();

  assert.match(patched, /if \(secureDfuAvailable\) \{\n    await runDirectSecureDfuRecovery\(\);/);
  assert.match(patched, /async function runDirectSecureDfuRecovery\(\)/);
  assert.match(patched, /already a verified Secure DFU bootloader/);
  assert.match(patched, /await dfu\.update\(bootloaderDevice, packageToFlash\.initPacket, packageToFlash\.firmware\)/);
  assert.match(patched, /without application-mode DFU entry/);

  const initIndex = patched.indexOf('const initPacket = await createMicrobitV2InitPacket(preparedFirmware.applicationBin);', patched.indexOf('async function runDirectSecureDfuRecovery'));
  const busyIndex = patched.indexOf('flashInProgress = true;', patched.indexOf('async function runDirectSecureDfuRecovery'));
  assert.ok(initIndex >= 0 && busyIndex >= 0 && initIndex < busyIndex, 'init packet must be prepared before locking the recovery UI');
});

test('ambiguous cached service table fails safe as application mode', () => {
  const patched = patchedSource();

  assert.match(patched, /if \(secureCharacteristicsAvailable && applicationServicesAvailable\)/);
  assert.match(patched, /Treating it as application mode until the service table becomes unambiguous/);
  assert.doesNotMatch(
    patched,
    /secureDfuAvailable = secureCharacteristicsAvailable;\n/,
  );
});
