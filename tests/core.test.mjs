import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_V2_FLASH_USABLE_END,
  V2_APPLICATION_START,
  createMicrobitV2InitPacket,
  extractUniversalHexImage,
  isUniversalHex,
  parseIntelHex,
  prepareFirmware,
  prepareHex,
  selectMarkerCandidate,
  toHex,
} from '../core.js';

function checksum(bytes) {
  return (-bytes.reduce((sum, value) => sum + value, 0)) & 0xff;
}

function record(address, type, data = []) {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  return `:${[...bytes, checksum(bytes)].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const marker = [...Buffer.from('708E3B92C615A841C49866C975EE5197', 'hex')];
const runtimeHash = [...Buffer.from('4A2F0065895EA2BA', 'hex')];
const programHash = [...Buffer.from('1122334455667788', 'hex')];
const vectorTable = [0x00, 0x00, 0x04, 0x20, 0x21, 0xc0, 0x01, 0x00, 1, 2, 3, 4, 5, 6, 7, 8];

function makeV2IntelHex({ includeMarker = true, secondMarker = false } = {}) {
  const lines = [
    record(0, 0x04, [0x00, 0x01]),
    record(0xc000, 0x00, vectorTable),
  ];
  if (includeMarker) {
    lines.push(record(0, 0x04, [0x00, 0x04]));
    lines.push(record(0x9000, 0x00, [...marker, ...runtimeHash, ...programHash]));
  }
  if (secondMarker) {
    lines.push(record(0, 0x04, [0x00, 0x05]));
    lines.push(record(0x1000, 0x00, [
      ...marker,
      ...Buffer.from('24E1B5FB51BE0862', 'hex'),
      ...Buffer.from('8877665544332211', 'hex'),
    ]));
  }
  lines.push(record(0, 0x04, [0x10, 0x00]));
  lines.push(record(0, 0x00, [1, 2, 3, 4]));
  lines.push(record(0, 0x01));
  lines.push('');
  return lines.join('\n');
}

test('valid Intel HEX is parsed and high-address records are ignored', () => {
  const parsed = parseIntelHex(makeV2IntelHex());
  assert.equal(parsed.binary[V2_APPLICATION_START], vectorTable[0]);
  assert.equal(parsed.binary[0x49000], marker[0]);
  assert.equal(parsed.ignoredHighRecords, 1);
  assert.equal(parsed.sawEof, true);
});

test('MakeCode marker, hashes and full V2 application binary are prepared', () => {
  const image = prepareFirmware(makeV2IntelHex());
  assert.equal(image.magicOffset, 0x49000);
  assert.equal(image.runtimeHash, '4A2F0065895EA2BA');
  assert.equal(image.programHash, '1122334455667788');
  assert.equal(image.estimatedTransferBytes, DEFAULT_V2_FLASH_USABLE_END - 0x49000);
  assert.equal(image.applicationStart, V2_APPLICATION_START);
  assert.equal(image.applicationBin[0], vectorTable[0]);
  assert.equal(image.applicationBin[0x49000 - V2_APPLICATION_START], marker[0]);
  assert.equal(image.applicationBin.length % 4, 0);
});

test('full DFU preparation works when no partial-flash marker is present', () => {
  const image = prepareFirmware(makeV2IntelHex({ includeMarker: false }));
  assert.equal(image.markerCandidates.length, 0);
  assert.equal(image.magicOffset, -1);
  assert.ok(image.applicationBytes >= vectorTable.length);
  assert.throws(() => prepareHex(makeV2IntelHex({ includeMarker: false })), /partial-flash/i);
});

test('multiple MakeCode marker candidates are retained and selectable', () => {
  const image = prepareFirmware(makeV2IntelHex({ secondMarker: true }));
  assert.equal(image.markerCandidates.length, 2);
  const second = image.markerCandidates[1];
  const selected = selectMarkerCandidate(image, second);
  assert.equal(selected.magicOffset, 0x51000);
  assert.equal(selected.runtimeHash, '24E1B5FB51BE0862');
});

test('Universal HEX V2 image is separated locally', () => {
  const universal = [
    record(0, 0x04, [0x00, 0x01]),
    record(0, 0x0a, [0x99, 0x03, 0xc0, 0xde]),
    record(0xc000, 0x0d, vectorTable),
    record(0, 0x0b),
    record(0, 0x04, [0x00, 0x04]),
    record(0, 0x0a, [0x99, 0x03, 0xc0, 0xde]),
    record(0x9000, 0x0d, [...marker, ...runtimeHash, ...programHash]),
    record(0, 0x0b),
    record(0, 0x01),
    '',
  ].join('\n');

  assert.equal(isUniversalHex(universal), true);
  const v2 = extractUniversalHexImage(universal);
  assert.equal(v2.boardId, 0x9903);
  assert.match(v2.intelHex, /:10C00000/);
  const image = prepareFirmware(universal);
  assert.equal(image.universal, true);
  assert.equal(image.magicOffset, 0x49000);
  assert.equal(toHex(image.binary.slice(0x49010, 0x49018)), '4A2F0065895EA2BA');
});

test('Universal HEX board id 0x9904 is accepted as V2', () => {
  const universal = [
    record(0, 0x04, [0x00, 0x01]),
    record(0, 0x0a, [0x99, 0x04, 0xc0, 0xde]),
    record(0xc000, 0x0d, vectorTable),
    record(0, 0x0b),
    record(0, 0x01),
    '',
  ].join('\n');
  const image = prepareFirmware(universal);
  assert.equal(image.boardId, 0x9904);
});

test('bad checksum is rejected', () => {
  const bad = makeV2IntelHex().replace(/.$/m, '0');
  assert.throws(() => parseIntelHex(bad), /checksum|byte count|characters/i);
});

test('V2 application must contain data at the application base', () => {
  const noVector = [
    record(0, 0x04, [0x00, 0x04]),
    record(0x9000, 0x00, [...marker, ...runtimeHash, ...programHash]),
    record(0, 0x01),
    '',
  ].join('\n');
  assert.throws(() => prepareFirmware(noVector), /vector table/i);
});

test('micro:bit V2 init packet contains reversed SHA-256 and application size', async () => {
  const application = Uint8Array.of(1, 2, 3, 4);
  const fakeDigest = Uint8Array.from({ length: 32 }, (_, index) => index);
  const fakeCrypto = {
    subtle: {
      digest: async () => fakeDigest.buffer.slice(0),
    },
  };
  const packet = await createMicrobitV2InitPacket(application, fakeCrypto);
  const view = new DataView(packet.buffer);
  assert.equal(new TextDecoder().decode(packet.slice(0, 12)), 'microbit_app');
  assert.equal(view.getUint32(12, true), 1);
  assert.equal(view.getUint32(16, true), 4);
  assert.equal(view.getUint32(20, true), 32);
  assert.deepEqual([...packet.slice(24)], [...fakeDigest].reverse());
});

test('init packet falls back to hash_size zero when SubtleCrypto is unavailable', async () => {
  const packet = await createMicrobitV2InitPacket(Uint8Array.of(1, 2, 3, 4), {});
  const view = new DataView(packet.buffer);
  assert.equal(view.getUint32(20, true), 0);
  assert.ok([...packet.slice(24)].every(value => value === 0));
});
