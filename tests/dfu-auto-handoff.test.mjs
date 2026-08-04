import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticDfuHandoffState } from '../handoff-state.js';

test('automatic target check runs only once per pending handoff', () => {
  const state = new AutomaticDfuHandoffState();
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'start-auto');
  assert.equal(state.evaluate({ visible: true, enabled: false, hasTarget: true }), 'auto-running');
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'manual-fallback');
});

test('hiding the pending handoff resets one-shot state', () => {
  const state = new AutomaticDfuHandoffState();
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'start-auto');
  assert.equal(state.evaluate({ visible: false, enabled: false, hasTarget: true }), 'idle');
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'start-auto');
});
