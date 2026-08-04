import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DFU_BUTTONLESS_BONDED_UUID,
  DFU_CONTROL_UUID,
  DFU_PACKET_UUID,
  DFU_SERVICE_UUID,
  GATT_SERVICE_CHANGED_UUID,
  GATT_SERVICE_UUID,
  armGattServiceChanged,
  crc32,
  enterButtonlessDfu,
  requestDfuDevice,
  waitForDfuBootloader,
} from '../dfu.js';

test('CRC32 matches the standard check vector', () => {
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc32(data), 0xcbf43926);
});

test('CRC32 handles empty data', () => {
  assert.equal(crc32(new Uint8Array()), 0x00000000);
});

function createMockDevice({ rejectWrites = 0, disconnectOnWrite = true } = {}) {
  const deviceListeners = new Map();
  let writeCalls = 0;
  let notificationCalls = 0;

  const button = {
    uuid: DFU_BUTTONLESS_BONDED_UUID,
    properties: {
      write: true,
      writeWithoutResponse: false,
      notify: false,
      indicate: true,
      read: false,
    },
    addEventListener() {},
    removeEventListener() {},
    async startNotifications() {
      notificationCalls++;
    },
    async writeValueWithResponse(value) {
      writeCalls++;
      assert.deepEqual([...value], [0x01]);
      if (writeCalls <= rejectWrites) throw new Error('GATT rejected');
      if (disconnectOnWrite) {
        queueMicrotask(() => {
          device.gatt.connected = false;
          deviceListeners.get('gattserverdisconnected')?.();
        });
      }
    },
  };

  const service = {
    async getCharacteristics() {
      return [button];
    },
  };

  const device = {
    name: 'BBC micro:bit [test]',
    gatt: {
      connected: true,
      async connect() {
        this.connected = true;
        return this;
      },
      async getPrimaryService(uuid) {
        assert.equal(uuid, DFU_SERVICE_UUID);
        return service;
      },
    },
    addEventListener(name, handler) {
      deviceListeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (deviceListeners.get(name) === handler) deviceListeners.delete(name);
    },
  };

  return {
    device,
    get writeCalls() { return writeCalls; },
    get notificationCalls() { return notificationCalls; },
  };
}

test('buttonless entry writes once and does not subscribe to indications', async () => {
  const mock = createMockDevice();
  await enterButtonlessDfu(mock.device, { rebootTimeoutMs: 100 });
  assert.equal(mock.writeCalls, 1);
  assert.equal(mock.notificationCalls, 0);
});

test('buttonless entry retries once on the same connection after a transient secured-write error', async () => {
  const mock = createMockDevice({ rejectWrites: 1 });
  await enterButtonlessDfu(mock.device, { authorizationWaitMs: 1, rebootTimeoutMs: 50 });
  assert.equal(mock.writeCalls, 2);
  assert.equal(mock.notificationCalls, 0);
});

test('buttonless entry fails after one bounded retry when no reboot occurs', async () => {
  const mock = createMockDevice({ rejectWrites: 2, disconnectOnWrite: false });
  await assert.rejects(
    enterButtonlessDfu(mock.device, { authorizationWaitMs: 1, rebootTimeoutMs: 5 }),
    /did not restart the micro:bit/i,
  );
  assert.equal(mock.writeCalls, 2);
  assert.equal(mock.notificationCalls, 0);
  assert.equal(mock.device.gatt.connected, true);
});

test('DFU fallback chooser filters on the advertised Secure DFU service', async () => {
  let captured;
  const bluetooth = {
    async requestDevice(options) {
      captured = options;
      return { name: 'DfuTarg' };
    },
  };
  await requestDfuDevice(bluetooth);
  assert.deepEqual(captured.filters, [{ services: [DFU_SERVICE_UUID] }]);
  assert.equal('acceptAllDevices' in captured, false);
  assert.deepEqual(captured.optionalServices, [DFU_SERVICE_UUID]);
});

test('automatic reconnect keeps the bonded connection alive while the GATT cache refreshes', async () => {
  let connectCalls = 0;
  let disconnectCalls = 0;
  let discoveryCalls = 0;

  const buttonless = {
    uuid: DFU_BUTTONLESS_BONDED_UUID,
    properties: { write: true },
  };
  const control = {
    uuid: DFU_CONTROL_UUID,
    properties: { notify: true },
  };
  const packet = {
    uuid: DFU_PACKET_UUID,
    properties: { writeWithoutResponse: true },
  };

  const device = {
    name: 'BBC micro:bit [test]',
    gatt: {
      connected: false,
      async connect() {
        connectCalls++;
        this.connected = true;
        return this;
      },
      disconnect() {
        disconnectCalls++;
        this.connected = false;
      },
      async getPrimaryServices() {
        return [{ uuid: DFU_SERVICE_UUID }];
      },
      async getPrimaryService(uuid) {
        assert.equal(uuid, DFU_SERVICE_UUID);
        discoveryCalls++;
        return {
          async getCharacteristics() {
            return discoveryCalls >= 2 ? [control, packet] : [buttonless];
          },
        };
      },
    },
  };

  const result = await waitForDfuBootloader(device, {
    initialDelayMs: 0,
    serviceChangedDelayMs: 0,
    pollMs: 1,
    reconnectAfterMs: 1000,
    timeoutMs: 100,
  });

  assert.equal(result, device);
  assert.equal(connectCalls, 1);
  assert.equal(disconnectCalls, 0);
  assert.ok(discoveryCalls >= 2);
});


test('arms the standard GATT Service Changed indication before DFU', async () => {
  let started = 0;
  let listener;
  const characteristic = {
    properties: { indicate: true, notify: false },
    addEventListener(name, handler) {
      assert.equal(name, 'characteristicvaluechanged');
      listener = handler;
    },
    removeEventListener() {},
    async startNotifications() {
      started++;
    },
  };
  const server = {
    async getPrimaryService(uuid) {
      assert.equal(uuid, GATT_SERVICE_UUID);
      return {
        async getCharacteristic(charUuid) {
          assert.equal(charUuid, GATT_SERVICE_CHANGED_UUID);
          return characteristic;
        },
      };
    },
  };

  let changed = false;
  const result = await armGattServiceChanged(server, {
    onChanged: () => { changed = true; },
  });
  assert.equal(started, 1);
  assert.equal(result.characteristic, characteristic);

  const bytes = Uint8Array.of(1, 0, 255, 255);
  listener({ target: { value: new DataView(bytes.buffer) } });
  assert.equal(changed, true);
});
