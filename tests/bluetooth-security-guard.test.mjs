import test from 'node:test';
import assert from 'node:assert/strict';

const BONDED_UUID = '8ec90004-f315-4f60-9fb8-838830daea50';

class FakeCharacteristic extends EventTarget {
  constructor(device) {
    super();
    this.uuid = BONDED_UUID;
    this.service = { device };
    this.startMode = 'reject';
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
  }

  async writeValueWithoutResponse() {
    this.writeCalls++;
  }

  async writeValue() {
    this.writeCalls++;
  }
}

globalThis.BluetoothRemoteGATTCharacteristic = FakeCharacteristic;
await import(`../bluetooth-security-reset.js?test=${Date.now()}`);

test('a failed authorization does not suppress the next real 0004 attempt', async () => {
  const device = { gatt: { connected: true } };
  const characteristic = new FakeCharacteristic(device);

  await assert.rejects(characteristic.startNotifications(), /GATT operation failed/);
  characteristic.startMode = 'success';
  await characteristic.startNotifications();

  assert.equal(characteristic.startCalls, 2);
});

test('the DFU reboot write is blocked until secured 0004 access is positively verified', async () => {
  const device = { gatt: { connected: true } };
  const characteristic = new FakeCharacteristic(device);
  let localFailureResponse = null;

  characteristic.addEventListener('characteristicvaluechanged', event => {
    localFailureResponse = new Uint8Array(
      event.target.value.buffer,
      event.target.value.byteOffset,
      event.target.value.byteLength,
    );
  });

  await assert.rejects(
    characteristic.writeValueWithResponse(Uint8Array.of(0x01)),
    error => error?.code === 'DFU_BOND_NOT_VERIFIED',
  );
  await new Promise(resolve => queueMicrotask(resolve));

  assert.equal(characteristic.writeCalls, 0);
  assert.deepEqual([...localFailureResponse], [0x20, 0x01, 0x0a]);

  characteristic.startMode = 'success';
  await characteristic.startNotifications();
  await characteristic.writeValueWithResponse(Uint8Array.of(0x01));
  assert.equal(characteristic.writeCalls, 1);
});
