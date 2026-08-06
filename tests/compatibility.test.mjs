import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBluetoothCompatibility } from '../compatibility.js';

const candidates = [
  { offset: 0x47000, runtimeHash: 'AAAAAAAAAAAAAAAA', programHash: '1111111111111111' },
  { offset: 0x49000, runtimeHash: 'BBBBBBBBBBBBBBBB', programHash: '2222222222222222' },
];

test('accepts an exact runtime and program-layout match', () => {
  const result = classifyBluetoothCompatibility({
    markerCandidates: candidates,
    deviceRuntimeHash: 'aaaaaaaaaaaaaaaa',
    deviceProgramStart: 0x47000,
  });
  assert.equal(result.supported, true);
  assert.equal(result.candidate, candidates[0]);
});

test('recommends USB when the file has no compatible marker', () => {
  const result = classifyBluetoothCompatibility({
    markerCandidates: [],
    deviceRuntimeHash: 'AAAAAAAAAAAAAAAA',
    deviceProgramStart: 0x47000,
  });
  assert.deepEqual(result, { supported: false, reason: 'file', candidate: null });
});

test('recommends USB when the program layout differs', () => {
  const result = classifyBluetoothCompatibility({
    markerCandidates: candidates,
    deviceRuntimeHash: 'AAAAAAAAAAAAAAAA',
    deviceProgramStart: 0x48000,
  });
  assert.deepEqual(result, { supported: false, reason: 'layout', candidate: null });
});

test('recommends USB when the installed software differs', () => {
  const result = classifyBluetoothCompatibility({
    markerCandidates: candidates,
    deviceRuntimeHash: 'CCCCCCCCCCCCCCCC',
    deviceProgramStart: 0x47000,
  });
  assert.deepEqual(result, { supported: false, reason: 'software', candidate: null });
});
