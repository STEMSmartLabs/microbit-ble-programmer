import test from 'node:test';
import assert from 'node:assert/strict';
import { installFreshDfuChooserHandoff } from '../dfu-handoff-policy.js';

class FakeDfu {
  constructor() { this.logs = []; }
  log(message) { this.logs.push(message); }
  async connectGatt() { throw new Error('original connectGatt should be patched'); }
}

test('fresh DFU handoff performs exactly one successful GATT connect', async () => {
  installFreshDfuChooserHandoff(FakeDfu, { readinessDelayMs: 0, connectionTimeoutMs: 50 });
  let connectCalls = 0;
  const server = { id: 'server' };
  const device = {
    name: 'DfuTarg',
    gatt: {
      connected: false,
      async connect() { connectCalls++; return server; },
      disconnect() {},
    },
  };
  const dfu = new FakeDfu();
  assert.equal(await dfu.connectGatt(device), server);
  assert.equal(connectCalls, 1);
  assert.match(dfu.logs.join('\n'), /single attempt/);
});

test('fresh DFU handoff returns after one timed-out GATT attempt', async () => {
  class TimeoutDfu {
    log() {}
    async connectGatt() { throw new Error('original connectGatt should be patched'); }
  }
  installFreshDfuChooserHandoff(TimeoutDfu, { readinessDelayMs: 0, connectionTimeoutMs: 20 });
  let connectCalls = 0;
  let disconnectCalls = 0;
  const device = {
    name: null,
    gatt: {
      connected: false,
      connect() { connectCalls++; return new Promise(() => {}); },
      disconnect() { disconnectCalls++; },
    },
  };
  const dfu = new TimeoutDfu();
  await assert.rejects(() => dfu.connectGatt(device), error => error.code === 'DFU_CANDIDATE_TIMEOUT');
  assert.equal(connectCalls, 1);
  assert.ok(disconnectCalls >= 1);
});
