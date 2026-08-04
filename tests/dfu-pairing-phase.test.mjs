import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeBondedButtonlessDfu,
  enterButtonlessDfu,
  DFU_BUTTONLESS_BONDED_UUID,
} from '../dfu.js';

class FakeButton extends EventTarget {
  constructor({ startMode = 'reject', device }) {
    super();
    this.uuid = DFU_BUTTONLESS_BONDED_UUID;
    this.properties = {
      write: true,
      writeWithoutResponse: false,
      notify: false,
      indicate: true,
    };
    this.startMode = startMode;
    this.device = device;
    this.startCalls = 0;
    this.writeCalls = 0;
  }

  async startNotifications() {
    this.startCalls++;
    if (this.startMode === 'reject') throw new Error('GATT operation failed');
    return this;
  }

  async writeValueWithResponse() {
    this.writeCalls++;
    setTimeout(() => {
      this.device.gatt.connected = false;
      this.device.dispatchEvent(new Event('gattserverdisconnected'));
    }, 10);
  }
}

function makeDevice(startMode = 'reject') {
  const device = new EventTarget();
  device.name = 'BBC micro:bit [test]';
  device.id = 'test-id';
  device.gatt = {
    connected: true,
    async connect() {
      this.connected = true;
      return this;
    },
  };

  const button = new FakeButton({ startMode, device });
  const service = {
    async getCharacteristics() {
      return [button];
    },
  };
  device.gatt.getPrimaryService = async () => service;
  return { device, button };
}

test('pairing phase never sends the Buttonless DFU reboot command', async () => {
  const { device, button } = makeDevice('reject');
  setTimeout(() => {
    device.gatt.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));
  }, 20);

  const result = await authorizeBondedButtonlessDfu(device, { timeoutMs: 1000 });
  assert.equal(result.disconnected, true);
  assert.equal(button.startCalls, 1);
  assert.equal(button.writeCalls, 0);
});

test('post-pairing DFU phase skips authorization and sends one reboot command', async () => {
  const { device, button } = makeDevice('success');
  await enterButtonlessDfu(device, {
    timeoutMs: 1000,
    skipAuthorization: true,
  });

  assert.equal(button.startCalls, 0);
  assert.equal(button.writeCalls, 1);
});
