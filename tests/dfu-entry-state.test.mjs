import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDfuEntry, DFU_ENTRY_RESULT } from '../dfu-entry-state.js';

test('accepted command is confirmed', () => {
  assert.equal(classifyDfuEntry({
    commandAccepted: true,
    writeSucceeded: false,
    disconnected: true,
  }), DFU_ENTRY_RESULT.CONFIRMED);
});

test('successful secured write is confirmed even when indication is missed', () => {
  assert.equal(classifyDfuEntry({
    commandAccepted: false,
    writeSucceeded: true,
    disconnected: true,
  }), DFU_ENTRY_RESULT.CONFIRMED);
});

test('failed write followed by disconnect is uncertain, not confirmed', () => {
  assert.equal(classifyDfuEntry({
    commandAccepted: false,
    writeSucceeded: false,
    disconnected: true,
  }), DFU_ENTRY_RESULT.UNCERTAIN);
});

test('failed write with no disconnect is a failed DFU entry', () => {
  assert.equal(classifyDfuEntry({
    commandAccepted: false,
    writeSucceeded: false,
    disconnected: false,
  }), DFU_ENTRY_RESULT.FAILED);
});
