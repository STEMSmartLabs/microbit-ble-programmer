import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_V2_FLASH_USABLE_END,
  extractUniversalHexImage,
  isUniversalHex,
  parseIntelHex,
  prepareHex,
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

function makeV2IntelHex() {
  return [
    record(0, 0x04, [0x00, 0x04]),
    record(0x9000, 0x00, [...marker, ...runtimeHash, ...programHash]),
    record(0, 0x04, [0x10, 0x00]),
    record(0, 0x00, [1, 2, 3, 4]),
    record(0, 0x01),
    '',
  ].join('\n');
}

test('valid Intel HEX is parsed and high-address records are ignored', () => {
  const parsed = parseIntelHex(makeV2IntelHex());
  assert.equal(parsed.binary[0x49000], marker[0]);
  assert.equal(parsed.ignoredHighRecords, 1);
  assert.equal(parsed.sawEof, true);
});

test('MakeCode marker and hashes are extracted', () => {
  const image = prepareHex(makeV2IntelHex());
  assert.equal(image.magicOffset, 0x49000);
  assert.equal(image.runtimeHash, '4A2F0065895EA2BA');
  assert.equal(image.programHash, '1122334455667788');
  assert.equal(image.estimatedTransferBytes, DEFAULT_V2_FLASH_USABLE_END - 0x49000);
});

test('Universal HEX V2 image is separated locally', () => {
  const universal = [
    record(0, 0x04, [0x00, 0x04]),
    record(0, 0x0a, [0x99, 0x03, 0xc0, 0xde]),
    record(0x9000, 0x0d, [...marker, ...runtimeHash, ...programHash]),
    record(0, 0x0b),
    record(0, 0x01),
    '',
  ].join('\n');

  assert.equal(isUniversalHex(universal), true);
  const v2 = extractUniversalHexImage(universal);
  assert.match(v2, /:20900000/);
  const image = prepareHex(universal);
  assert.equal(image.universal, true);
  assert.equal(image.magicOffset, 0x49000);
  assert.equal(toHex(image.binary.slice(0x49010, 0x49018)), '4A2F0065895EA2BA');
});


test('Universal HEX preserves changed extended addresses across V2 blocks', () => {
  const universal = [
    record(0, 0x04, [0x00, 0x04]),
    record(0, 0x0a, [0x99, 0x03, 0xc0, 0xde]),
    record(0x9000, 0x0d, [...marker, ...runtimeHash, ...programHash]),
    record(0, 0x0b),
    record(0, 0x04, [0x00, 0x05]),
    record(0, 0x0a, [0x99, 0x03, 0xc0, 0xde]),
    record(0x0010, 0x0d, [0xaa, 0xbb, 0xcc, 0xdd]),
    record(0, 0x0b),
    record(0, 0x01),
    '',
  ].join('\n');

  const v2 = extractUniversalHexImage(universal);
  const parsed = parseIntelHex(v2);
  assert.equal(parsed.binary[0x50010], 0xaa);
  assert.equal(parsed.binary[0x50013], 0xdd);
});

test('bad checksum is rejected', () => {
  const bad = makeV2IntelHex().replace(/.$/m, '0');
  assert.throws(() => parseIntelHex(bad), /checksum|byte count|characters/i);
});

test('non-MakeCode HEX is rejected', () => {
  const plain = [record(0, 0x00, [1, 2, 3, 4]), record(0, 0x01), ''].join('\n');
  assert.throws(() => prepareHex(plain), /compatible MakeCode/i);
});
