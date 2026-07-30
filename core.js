/**
 * Core HEX parsing helpers for the STEM Smart Labs micro:bit BLE Flasher.
 *
 * Universal HEX separation logic is adapted from the Micro:bit Educational
 * Foundation's microbit-universal-hex project (MIT licensed). See
 * THIRD_PARTY_NOTICES.md.
 */

export const V2_BOARD_ID = 0x9903;
export const V2_FLASH_END = 0x80000;
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

/**
 * Extracts the requested board image from a Universal HEX and returns a normal
 * Intel HEX. Only the record types required for separation are implemented.
 */
export function extractUniversalHexImage(universalHex, wantedBoardId = V2_BOARD_ID) {
  const lines = recordLines(universalHex);
  if (!lines.length) throw new Error('Empty Universal HEX');

  const parsed = lines.map((line, index) => parseRecord(line, index + 1));
  if (parsed[0]?.type !== RECORD_TYPE.EXTENDED_LINEAR_ADDRESS
      || parsed[1]?.type !== RECORD_TYPE.BLOCK_START
      || parsed.at(-1)?.type !== RECORD_TYPE.EOF) {
    throw new Error('Universal HEX format is invalid');
  }

  const images = new Map();
  let currentBoardId = null;
  let currentEla = null;

  for (let index = 0; index < parsed.length; index++) {
    const record = parsed[index];

    if (record.type === RECORD_TYPE.EXTENDED_LINEAR_ADDRESS) {
      const next = parsed[index + 1];
      if (next?.type === RECORD_TYPE.BLOCK_START) {
        if (next.data.length !== 4 || next.data[2] !== 0xc0 || next.data[3] !== 0xde) {
          throw new Error('Universal HEX block-start record is invalid');
        }
        currentBoardId = (next.data[0] << 8) | next.data[1];
        currentEla = record.raw;
        if (!images.has(currentBoardId)) images.set(currentBoardId, { records: [], lastEla: null });
        const image = images.get(currentBoardId);
        if (image.lastEla !== record.raw) {
          image.records.push(record.raw);
          image.lastEla = record.raw;
        }
        index++;
        continue;
      }

      if (currentBoardId !== null) {
        const image = images.get(currentBoardId);
        if (image.lastEla !== record.raw) {
          image.records.push(record.raw);
          image.lastEla = record.raw;
        }
      }
      currentEla = record.raw;
      continue;
    }

    if (currentBoardId === null) continue;
    const image = images.get(currentBoardId);

    if (record.type === RECORD_TYPE.CUSTOM_DATA) {
      image.records.push(makeRecord(record.address, RECORD_TYPE.DATA, record.data));
    } else if ([
      RECORD_TYPE.DATA,
      RECORD_TYPE.EXTENDED_SEGMENT_ADDRESS,
      RECORD_TYPE.START_SEGMENT_ADDRESS,
    ].includes(record.type)) {
      image.records.push(record.raw);
    } else if (record.type === RECORD_TYPE.EOF) {
      image.records.push(record.raw);
    } else if (record.type === RECORD_TYPE.BLOCK_END || record.type === RECORD_TYPE.PADDED_DATA) {
      // Deliberately ignored; these records only frame/pad a Universal HEX block.
    }

    if (currentEla && image.lastEla !== currentEla) {
      image.lastEla = currentEla;
    }
  }

  const selected = images.get(wantedBoardId);
  if (!selected) throw new Error('Universal HEX does not contain a micro:bit V2 image');
  if (selected.records.at(-1) !== ':00000001FF') selected.records.push(':00000001FF');
  return `${selected.records.join('\n')}\n`;
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
  let ignoredHighRecords = 0;
  let sawEof = false;
  let lineNumber = 0;

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

  return { binary: output, copiedBytes, highestWritten, ignoredHighRecords, dataRecords, sawEof };
}

export function findMarker(binary, marker = MAGIC_MARKER, alignment = 16) {
  for (let offset = 0; offset + marker.length <= binary.length; offset += alignment) {
    let matches = true;
    for (let index = 0; index < marker.length; index++) {
      if (binary[offset + index] !== marker[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return offset;
  }
  return -1;
}

export function prepareHex(hexText) {
  if (typeof hexText !== 'string' || !hexText.trim()) throw new Error('The selected HEX file is empty');

  const universal = isUniversalHex(hexText);
  const intelHex = universal ? extractUniversalHexImage(hexText, V2_BOARD_ID) : hexText;
  const parsed = parseIntelHex(intelHex, V2_FLASH_END);
  const magicOffset = findMarker(parsed.binary);

  if (magicOffset < 0) throw new Error('Not a compatible MakeCode partial-flash HEX');
  if (magicOffset + 32 > parsed.binary.length) throw new Error('MakeCode metadata block is incomplete');
  if (magicOffset >= V2_FLASH_END) throw new Error('MakeCode program starts outside micro:bit V2 flash');

  const runtimeHash = toHex(parsed.binary.slice(magicOffset + 16, magicOffset + 24));
  const programHash = toHex(parsed.binary.slice(magicOffset + 24, magicOffset + 32));
  if (/^(00)+$/.test(runtimeHash) || /^(FF)+$/.test(runtimeHash)) throw new Error('MakeCode runtime hash is invalid');
  if (/^(00)+$/.test(programHash) || /^(FF)+$/.test(programHash)) throw new Error('MakeCode program hash is invalid');

  return {
    ...parsed,
    universal,
    magicOffset,
    runtimeHash,
    programHash,
    estimatedTransferEnd: DEFAULT_V2_FLASH_USABLE_END,
    estimatedTransferBytes: Math.max(0, DEFAULT_V2_FLASH_USABLE_END - magicOffset),
  };
}

export function formatHexAddress(value) {
  return `0x${value.toString(16).toUpperCase().padStart(5, '0')}`;
}

export function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
}
