import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AutomaticDfuHandoffState } from '../handoff-state.js';

const layer = await readFile(new URL('../auto-dfu-handoff.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('automatic handoff runs only once while the DFU selector remains visible', () => {
  const state = new AutomaticDfuHandoffState();

  assert.equal(state.evaluate({ visible: false, enabled: false, hasTarget: true }), 'idle');
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'start-auto');

  // The app disables the button while the automatic connection is running.
  assert.equal(state.evaluate({ visible: true, enabled: false, hasTarget: true }), 'auto-running');

  // When the failed attempt re-enables the button, it must become manual only.
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'manual-fallback');
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'manual-fallback');
});

test('a new pending DFU handoff can run one automatic attempt again', () => {
  const state = new AutomaticDfuHandoffState();
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'start-auto');
  assert.equal(state.evaluate({ visible: false, enabled: false, hasTarget: true }), 'idle');
  assert.equal(state.evaluate({ visible: true, enabled: true, hasTarget: true }), 'start-auto');
});

test('the browser chooser remains the fallback after automatic permission reuse', () => {
  assert.match(layer, /return targetMicrobit/);
  assert.match(layer, /const selected = await originalRequestDevice\(options\)/);
  assert.match(layer, /Select DfuTarg manually/);
  assert.match(html, /one automatic same-device attempt/i);
});

test('the automatic attempt is not re-armed merely because the button is disabled', () => {
  assert.doesNotMatch(layer, /else if \(!ready\)\s*\{\s*selectorWasReady = false/);
  assert.match(layer, /subsequent disabled\/enabled transitions[\s\S]*must never re-arm/i);
});
