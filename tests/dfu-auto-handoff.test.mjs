import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const layer = await readFile(new URL('../auto-dfu-handoff.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('automatic handoff reuses the already permitted target micro:bit once', () => {
  assert.match(layer, /return targetMicrobit/);
  assert.match(layer, /automaticRequestArmed = false/);
  assert.match(layer, /button\.click\(\)/);
});

test('manual DfuTarg picker remains available after the automatic attempt', () => {
  assert.match(layer, /const selected = await originalRequestDevice\(options\)/);
  assert.match(html, /manual DfuTarg selector appears only if automatic reconnect fails/i);
});

test('proven v2.2.9 transfer safeguards remain unchanged', () => {
  assert.match(app, /packetDelayMs: 4/);
  assert.match(app, /packetReceiptInterval: 12/);
  assert.match(app, /objectDrainDelayMs: 150/);
});
