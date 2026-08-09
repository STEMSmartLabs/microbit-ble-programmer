import test from 'node:test';
import assert from 'node:assert/strict';
import { installChecksumPacedFirmwareTransfer } from '../dfu-transfer-policy.js';

function crc32(data, seed = 0xffffffff) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let crc = seed >>> 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class FakeDfu {
  constructor(firmware, checksumOffsets = []) {
    this.firmware = firmware;
    this.checksumOffsets = checksumOffsets;
    this.packetDelayMs = 4;
    this.recoveryPacketDelayMs = 10;
    this.objectDrainDelayMs = 0;
    this.maxTailRecoveryAttempts = 2;
    this.logs = [];
    this.prnValues = [];
    this.writes = [];
    this.executes = 0;
    this.checksumCalls = 0;
  }

  async transferFirmware() { throw new Error('original transfer should be replaced'); }
  async selectObject() { return { maxSize: 4096, offset: 0, crc: crc32(new Uint8Array()) }; }
  progress() {}
  verifyPrefix(data, offset, expectedCrc) { return crc32(data.slice(0, offset)) === (expectedCrc >>> 0); }
  async createObject() {}
  async setPacketReceiptNotifications(value) { this.prnValues.push(value); }
  log(message, level) { this.logs.push({ message, level }); }
  async writePackets(_data, baseOffset, _type, options) { this.writes.push({ baseOffset, options }); }
  async checksum() {
    const offset = this.checksumOffsets[this.checksumCalls]
      ?? Math.min((this.checksumCalls + 1) * 4096, this.firmware.length);
    this.checksumCalls++;
    return { offset, crc: crc32(this.firmware.slice(0, offset)) };
  }
  async execute() { this.executes++; }
}

installChecksumPacedFirmwareTransfer(FakeDfu);

test('first firmware object is stabilized while later objects return to normal pacing', async () => {
  const firmware = Uint8Array.from({ length: 8192 }, (_, index) => index & 0xff);
  const dfu = new FakeDfu(firmware, [4096, 8192]);
  dfu.firstFirmwareObjectSettleMs = 0;
  dfu.firstFirmwareObjectDrainDelayMs = 0;
  await dfu.transferFirmware(firmware);

  assert.deepEqual(dfu.prnValues, [0, 0]);
  assert.equal(dfu.writes.length, 2);
  assert.equal(dfu.writes[0].baseOffset, 0);
  assert.equal(dfu.writes[0].options.receiptInterval, 0);
  assert.equal(dfu.writes[0].options.packetDelayMs, 15);
  assert.equal(dfu.writes[1].baseOffset, 4096);
  assert.equal(dfu.writes[1].options.packetDelayMs, 8);
  assert.equal(dfu.executes, 2);
  assert.ok(dfu.logs.some(entry => entry.message.includes('Stabilizing the first firmware data object')));
});

test('short first object resumes from bootloader checksum offset using stabilized pacing', async () => {
  const firmware = Uint8Array.from({ length: 4096 }, (_, index) => (index * 17) & 0xff);
  const dfu = new FakeDfu(firmware, [4016, 4096]);
  dfu.firstFirmwareObjectSettleMs = 0;
  dfu.firstFirmwareObjectDrainDelayMs = 0;
  await dfu.transferFirmware(firmware);

  assert.equal(dfu.writes.length, 2);
  assert.equal(dfu.writes[0].baseOffset, 0);
  assert.equal(dfu.writes[0].options.packetDelayMs, 15);
  assert.equal(dfu.writes[1].baseOffset, 4016);
  assert.equal(dfu.writes[1].options.packetDelayMs, 15);
  assert.equal(dfu.executes, 1);
  assert.ok(dfu.logs.some(entry => entry.message.includes('retransmitting the remaining 80 bytes')));
});
