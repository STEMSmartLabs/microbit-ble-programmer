import assert from 'node:assert/strict';
import test from 'node:test';

import { installVerifiedDfuResume } from '../dfu-resume-policy.js';

function fakeDevice() {
  return {
    name: 'BBC micro:bit',
    gatt: {
      connected: false,
      connectCalls: 0,
      disconnectCalls: 0,
      async connect() {
        this.connectCalls++;
        this.connected = true;
        return this;
      },
      disconnect() {
        this.disconnectCalls++;
        this.connected = false;
      },
    },
  };
}

test('verified Secure DFU transport failure reconnects same device and resumes', async () => {
  class FakeDfu {
    constructor() {
      this.logs = [];
      this.updateCalls = 0;
      this.connectCalls = 0;
      this.lastConfiguredPrn = null;
    }
    log(message, level) { this.logs.push({ message, level }); }
    async connect() { this.connectCalls++; }
    async setPacketReceiptNotifications(interval) { this.lastConfiguredPrn = interval; }
    async sendControl() {}
    async writePackets() {}
    async update(device) {
      this.updateCalls++;
      await this.connect(device);
      if (this.updateCalls === 1) throw new Error('GATT operation failed for unknown reason.');
      return 'completed';
    }
  }

  installVerifiedDfuResume(FakeDfu, { reconnectDelaysMs: [0], connectionTimeoutMs: 100 });
  const dfu = new FakeDfu();
  const device = fakeDevice();

  const result = await dfu.update(device, new Uint8Array([1]), new Uint8Array([2]));

  assert.equal(result, 'completed');
  assert.equal(dfu.updateCalls, 2);
  assert.equal(device.gatt.connectCalls, 1);
  assert.ok(dfu.logs.some(entry => entry.message.includes('automatically resuming')));
  assert.ok(dfu.logs.some(entry => entry.message.includes('bootloader-reported offset and CRC')));
});

test('failure before Secure DFU verification is not automatically retried', async () => {
  class FakeDfu {
    constructor() { this.updateCalls = 0; }
    log() {}
    async connect() { throw new Error('Selected entry is still exposing application Buttonless DFU'); }
    async setPacketReceiptNotifications() {}
    async sendControl() {}
    async writePackets() {}
    async update(device) {
      this.updateCalls++;
      await this.connect(device);
    }
  }

  installVerifiedDfuResume(FakeDfu, { reconnectDelaysMs: [0], connectionTimeoutMs: 100 });
  const dfu = new FakeDfu();
  const device = fakeDevice();

  await assert.rejects(() => dfu.update(device, new Uint8Array([1]), new Uint8Array([2])), /application Buttonless DFU/);
  assert.equal(dfu.updateCalls, 1);
  assert.equal(device.gatt.connectCalls, 0);
});

test('identical PRN configuration is not resent on the same connection', async () => {
  class FakeDfu {
    constructor() {
      this.prnWrites = 0;
      this.lastConfiguredPrn = null;
    }
    log() {}
    async connect() {}
    async update() {}
    async sendControl() {}
    async writePackets() {}
    async setPacketReceiptNotifications(interval) {
      this.prnWrites++;
      this.lastConfiguredPrn = interval;
    }
  }

  installVerifiedDfuResume(FakeDfu);
  const dfu = new FakeDfu();

  await dfu.setPacketReceiptNotifications(0);
  await dfu.setPacketReceiptNotifications(0);
  await dfu.setPacketReceiptNotifications(1);

  assert.equal(dfu.prnWrites, 2);
});

test('control and packet failures include operation context', async () => {
  class FakeDfu {
    log() {}
    async connect() {}
    async update() {}
    async setPacketReceiptNotifications() {}
    async sendControl() { throw new Error('GATT operation failed for unknown reason.'); }
    async writePackets() { throw new Error('GATT operation failed for unknown reason.'); }
  }

  installVerifiedDfuResume(FakeDfu);
  const dfu = new FakeDfu();

  await assert.rejects(() => dfu.sendControl(0x03), /Calculate Checksum \(opcode 0x03\) failed/);
  await assert.rejects(() => dfu.writePackets(new Uint8Array(80), 16384, 'firmware'), /byte range 16384–16464/);
});
