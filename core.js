/**
 * Core HEX parsing and micro:bit V2 firmware preparation helpers.
 *
 * Universal HEX separation is adapted from the Micro:bit Educational
 * Foundation's universal-hex tooling. Full-DFU application extraction follows
 * the micro:bit Android application region: 0x1C000..0x77000.
 */

export const V2_BOARD_IDS = Object.freeze([0x9903, 0x9904]);
export const V2_BOARD_ID = 0x9903;
export const V2_FLASH_END = 0x80000;
export const V2_APPLICATION_START = 0x1c000;
export const V2_APPLICATION_END = 0x77000;
export const DEFAULT_V2_FLASH_USABLE_END = 0x73000;
export const MAGIC_MARKER = hexBytes('708E3B92C615A841C49866C975EE5197');

const RECORD_TYPE = Object.freeze({
  DATA: 0x00,
  EOF: 0x01,
  EXTENDED_SEGMENT_ADDRESS: 0x02,
  START_SEGMENT_ADDRESS: 0x03,
  EXTENDED_LINEAR_ADDRESS: 0x04,
  START_LINEAR_ADDRESS: 0x05,
  BLOCK_START: 0x0a,
  BLOCK_END: 0x0b,
  PADDED_DATA: 0x0c,
  CUSTOM_DATA: 0x0d,
  OTHER_DATA: 0x0e,
});

export function hexBytes(value) {
  const clean = value.replace(/\s+/g, '');
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    throw new Error('Invalid hexadecimal data');
  }
  return Uint8Array.from(clean.match(/../g).map(pair => Number.parseInt(pair, 16)));
}

export function toHex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function checksumByte(bytesWithoutChecksum) {
  const sum = bytesWithoutChecksum.reduce((total, value) => (total + value) & 0xff, 0);
  return (-sum) & 0xff;
}

function makeRecord(address, type, data) {
  const body = Uint8Array.from([
    data.length,
    (address >>> 8) & 0xff,
    address & 0xff,
    type,
    ...data,
  ]);
  return `:${toHex(body)}${checksumByte(body).toString(16).padStart(2, '0').toUpperCase()}`;
}

function parseRecord(line, lineNumber = 0) {
  const where = lineNumber ? ` at line ${lineNumber}` : '';
  if (!line.startsWith(':')) throw new Error(`Invalid Intel HEX${where}: missing ':'`);
  const payload = line.slice(1);
  if (payload.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(payload)) {
    throw new Error(`Invalid Intel HEX characters${where}`);
  }

  const bytes = hexBytes(payload);
  if (bytes.length < 5) throw new Error(`Intel HEX record too short${where}`);
  const count = bytes[0];
  if (bytes.length !== count + 5) throw new Error(`Intel HEX byte count mismatch${where}`);
  if (bytes.reduce((sum, value) => (sum + value) & 0xff, 0) !== 0) {
    throw new Error(`Intel HEX checksum error${where}`);
  }

  return {
    raw: line,
    count,
    address: (bytes[1] << 8) | bytes[2],
    type: bytes[3],
    data: bytes.slice(4, 4 + count),
  };
}

function recordLines(hexText) {
  return hexText.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
}

export function isUniversalHex(hexText) {
  const lines = recordLines(hexText);
  if (lines.length < 3) return false;
  try {
    return parseRecord(lines[0]).type === RECORD_TYPE.EXTENDED_LINEAR_ADDRESS
      && parseRecord(lines[1]).type === RECORD_TYPE.BLOCK_START;
  } catch {
    return false;
  }
}

function normalizeWantedBoardIds(wantedBoardIds) {
  if (Array.isArray(wantedBoardIds)) return wantedBoardIds;
  return [wantedBoardIds];
}

/**
 * Extracts the requested micro:bit image from a Universal HEX and returns a
 * normal Intel HEX. V2 board IDs 0x9903 and 0x9904 are accepted by default.
 */
export function extractUniversalHexImage(universalHex, wantedBoardIds = V2_BOARD_IDS) {
  const wanted = new Set(normalizeWantedBoardIds(wantedBoardIds));
  const lines = recordLines(universalHex);
  if (!lines.length) throw new Error('Empty Universal HEX');

  const parsed = lines.map((line, index) => parseRecord(line, index + 1));
  if (parsed[0]?.type !== RECORD_TYPE.EXTENDED_LINEAR_ADDRESS
      || parsed[1]?.type !== RECORD_TYPE.BLOCK_START
      || parsed.at(-1)?.type !== RECORD_TYPE.EOF) {
    throw new Error('Universal HEX format is invalid');
  }

  const records = [];
  const matchedBoardIds = new Set();
  let currentBoardId = null;
  let currentWanted = false;
  let currentEla = null;
  let lastOutputEla = null;

  for (let index = 0; index < parsed.length; index++) {
    const record = parsed[index];

    if (record.type === RECORD_TYPE.EXTENDED_LINEAR_ADDRESS) {
      const next = parsed[index + 1];
      currentEla = record.raw;

      if (next?.type === RECORD_TYPE.BLOCK_START) {
        if (next.data.length !== 4 || next.data[2] !== 0xc0 || next.data[3] !== 0xde) {
          throw new Error('Universal HEX block-start record is invalid');
        }
        currentBoardId = (next.data[0] << 8) | next.data[1];
        currentWanted = wanted.has(currentBoardId);
        if (currentWanted) {
          matchedBoardIds.add(currentBoardId);
          if (lastOutputEla !== currentEla) {
            records.push(currentEla);
            lastOutputEla = currentEla;
          }
        }
        index++;
        continue;
      }

      if (currentWanted && lastOutputEla !== currentEla) {
        records.push(currentEla);
        lastOutputEla = currentEla;
      }
      continue;
    }

    if (record.type === RECORD_TYPE.EOF) break;
    if (!currentWanted) continue;

    if (record.type === RECORD_TYPE.CUSTOM_DATA) {
      records.push(makeRecord(record.address, RECORD_TYPE.DATA, record.data));
    } else if ([
      RECORD_TYPE.DATA,
      RECORD_TYPE.EXTENDED_SEGMENT_ADDRESS,
      RECORD_TYPE.START_SEGMENT_ADDRESS,
    ].includes(record.type)) {
      records.push(record.raw);
    }
  }

  if (!matchedBoardIds.size || !records.length) {
    throw new Error('Universal HEX does not contain a micro:bit V2 image');
  }
  records.push(':00000001FF');
  return {
    boardId: [...matchedBoardIds][0],
    boardIds: [...matchedBoardIds],
    intelHex: `${records.join('\n')}\n`,
  };
}

export function parseIntelHex(hexText, flashEnd = V2_FLASH_END) {
  if (!Number.isInteger(flashEnd) || flashEnd <= 0 || flashEnd > V2_FLASH_END) {
    throw new Error('Invalid flash boundary');
  }

  const output = new Uint8Array(flashEnd);
  output.fill(0xff);

  let baseAddress = 0;
  let dataRecords = 0;
  let copiedBytes = 0;
  let highestWritten = 0;
  let lowestWritten = flashEnd;
  let ignoredHighRecords = 0;
  let sawEof = false;
  let lineNumber = 0;
  const writtenRanges = [];

  for (const rawLine of hexText.split(/\r?\n/)) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;
    const record = parseRecord(line, lineNumber);

    if (record.type === RECORD_TYPE.DATA || record.type === RECORD_TYPE.CUSTOM_DATA) {
      dataRecords++;
      const absoluteStart = baseAddress + record.address;
      const absoluteEnd = absoluteStart + record.data.length;

      if (absoluteStart >= flashEnd || absoluteEnd <= 0) {
        ignoredHighRecords++;
        continue;
      }

      const copyStart = Math.max(0, absoluteStart);
      const copyEnd = Math.min(flashEnd, absoluteEnd);
      const sourceStart = copyStart - absoluteStart;
      const length = copyEnd - copyStart;
      if (length > 0) {
        output.set(record.data.slice(sourceStart, sourceStart + length), copyStart);
        copiedBytes += length;
        highestWritten = Math.max(highestWritten, copyEnd);
        lowestWritten = Math.min(lowestWritten, copyStart);
        writtenRanges.push({ start: copyStart, end: copyEnd });
      }
    } else if (record.type === RECORD_TYPE.EOF) {
      sawEof = true;
      break;
    } else if (record.type === RECORD_TYPE.EXTENDED_SEGMENT_ADDRESS) {
      if (record.data.length !== 2) throw new Error(`Bad segment-address record at line ${lineNumber}`);
      baseAddress = ((((record.data[0] << 8) | record.data[1]) << 4) >>> 0);
    } else if (record.type === RECORD_TYPE.EXTENDED_LINEAR_ADDRESS) {
      if (record.data.length !== 2) throw new Error(`Bad linear-address record at line ${lineNumber}`);
      baseAddress = ((((record.data[0] << 8) | record.data[1]) << 16) >>> 0);
    }
  }

  if (!dataRecords || !copiedBytes) throw new Error('The selected file contains no micro:bit V2 flash data');

  return {
    binary: output,
    copiedBytes,
    highestWritten,
    lowestWritten: lowestWritten === flashEnd ? 0 : lowestWritten,
    ignoredHighRecords,
    dataRecords,
    sawEof,
    writtenRanges,
  };
}

export function findMarkers(binary, marker = MAGIC_MARKER, alignment = 16) {
  const matches = [];
  for (let offset = 0; offset + marker.length <= binary.length; offset += alignment) {
    let found = true;
    for (let index = 0; index < marker.length; index++) {
      if (binary[offset + index] !== marker[index]) {
        found = false;
        break;
      }
    }
    if (found) matches.push(offset);
  }
  return matches;
}

export function findMarker(binary, marker = MAGIC_MARKER, alignment = 16) {
  return findMarkers(binary, marker, alignment)[0] ?? -1;
}

function validHash(hash) {
  return !/^(00)+$/.test(hash) && !/^(FF)+$/.test(hash);
}

function markerCandidates(binary) {
  return findMarkers(binary)
    .filter(offset => offset + 32 <= binary.length)
    .map(offset => ({
      offset,
      runtimeHash: toHex(binary.slice(offset + 16, offset + 24)),
      programHash: toHex(binary.slice(offset + 24, offset + 32)),
    }))
    .filter(candidate => validHash(candidate.runtimeHash) && validHash(candidate.programHash));
}

function align4(value) {
  return (value + 3) & ~3;
}

export function extractV2ApplicationBinary(parsed) {
  const relevant = parsed.writtenRanges
    .map(range => ({
      start: Math.max(range.start, V2_APPLICATION_START),
      end: Math.min(range.end, V2_APPLICATION_END),
    }))
    .filter(range => range.end > range.start);

  if (!relevant.length) {
    throw new Error(`HEX contains no application data in ${formatHexAddress(V2_APPLICATION_START)}–${formatHexAddress(V2_APPLICATION_END)}`);
  }

  const highest = Math.max(...relevant.map(range => range.end));
  const firstPage = parsed.binary.slice(V2_APPLICATION_START, Math.min(V2_APPLICATION_START + 32, highest));
  if (![...firstPage].some(value => value !== 0xff)) {
    throw new Error(`HEX does not contain an application vector table at ${formatHexAddress(V2_APPLICATION_START)}`);
  }

  const length = align4(highest - V2_APPLICATION_START);
  if (length <= 0 || V2_APPLICATION_START + length > V2_APPLICATION_END) {
    throw new Error('HEX application image exceeds the micro:bit V2 DFU application region');
  }

  const applicationBin = parsed.binary.slice(V2_APPLICATION_START, V2_APPLICATION_START + length);
  return {
    applicationBin,
    applicationStart: V2_APPLICATION_START,
    applicationEnd: V2_APPLICATION_START + length,
    applicationBytes: length,
  };
}

export function selectMarkerCandidate(image, candidate) {
  if (!candidate) {
    return {
      ...image,
      magicOffset: -1,
      runtimeHash: null,
      programHash: null,
    };
  }
  return {
    ...image,
    magicOffset: candidate.offset,
    runtimeHash: candidate.runtimeHash,
    programHash: candidate.programHash,
  };
}

/**
 * Parses a V2 MakeCode/Intel HEX for both partial and full application DFU.
 * A valid application can be full-flashed even if no partial-flash marker is
 * present. markerCandidates is empty in that case.
 */
export function prepareFirmware(hexText) {
  if (typeof hexText !== 'string' || !hexText.trim()) throw new Error('The selected HEX file is empty');

  const universal = isUniversalHex(hexText);
  let boardId = V2_BOARD_ID;
  let intelHex = hexText;
  if (universal) {
    const extracted = extractUniversalHexImage(hexText, V2_BOARD_IDS);
    boardId = extracted.boardId;
    intelHex = extracted.intelHex;
  }

  const parsed = parseIntelHex(intelHex, V2_FLASH_END);
  const candidates = markerCandidates(parsed.binary);
  const application = extractV2ApplicationBinary(parsed);
  const selected = candidates[0] ?? null;

  return selectMarkerCandidate({
    ...parsed,
    universal,
    boardId,
    intelHex,
    markerCandidates: candidates,
    estimatedTransferEnd: DEFAULT_V2_FLASH_USABLE_END,
    estimatedTransferBytes: selected
      ? Math.max(0, DEFAULT_V2_FLASH_USABLE_END - selected.offset)
      : 0,
    ...application,
  }, selected);
}

/** Backwards-compatible partial-flash parser. */
export function prepareHex(hexText) {
  const image = prepareFirmware(hexText);
  if (!image.markerCandidates.length) throw new Error('Not a compatible MakeCode partial-flash HEX');
  return image;
}

/**
 * Creates the 56-byte micro:bit V2 application init packet accepted by the
 * Foundation V2 bootloader. The SHA-256 digest is byte-reversed to match the
 * bootloader validation routine. When SubtleCrypto is unavailable, hash_size
 * is set to zero, which the bootloader treats as no hash validation.
 */
export async function createMicrobitV2InitPacket(applicationBin, cryptoProvider = globalThis.crypto) {
  if (!(applicationBin instanceof Uint8Array) || applicationBin.length === 0) {
    throw new Error('Application binary is empty');
  }

  let hash = new Uint8Array(32);
  let hashSize = 0;
  if (cryptoProvider?.subtle) {
    const digest = await cryptoProvider.subtle.digest('SHA-256', applicationBin);
    hash = new Uint8Array(digest);
    hash.reverse();
    hashSize = 32;
  }

  const packet = new Uint8Array(56);
  const view = new DataView(packet.buffer);
  packet.set(new TextEncoder().encode('microbit_app'), 0);
  view.setUint32(12, 1, true);
  view.setUint32(16, applicationBin.length, true);
  view.setUint32(20, hashSize, true);
  packet.set(hash, 24);
  return packet;
}

export function formatHexAddress(value) {
  return `0x${value.toString(16).toUpperCase().padStart(5, '0')}`;
}

export function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
}
