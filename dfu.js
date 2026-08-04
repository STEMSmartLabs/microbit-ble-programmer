/**
 * Nordic Secure DFU transport for Web Bluetooth.
 *
 * Protocol handling is adapted from the MIT-licensed
 * thegecko/web-bluetooth-dfu project and Nordic's Secure DFU protocol.
 */

export const DFU_SERVICE_UUID = 0xfe59;
export const DFU_CONTROL_UUID = '8ec90001-f315-4f60-9fb8-838830daea50';
export const DFU_PACKET_UUID = '8ec90002-f315-4f60-9fb8-838830daea50';
export const DFU_BUTTONLESS_UUID = '8ec90003-f315-4f60-9fb8-838830daea50';
export const DFU_BUTTONLESS_BONDED_UUID = '8ec90004-f315-4f60-9fb8-838830daea50';

const OP = Object.freeze({
  CREATE: 0x01,
  SET_PRN: 0x02,
  CRC: 0x03,
  EXECUTE: 0x04,
  SELECT: 0x06,
  RESPONSE: 0x60,
});

const OBJECT = Object.freeze({ COMMAND: 0x01, DATA: 0x02 });
const RESULT = Object.freeze({ SUCCESS: 0x01, EXTENDED_ERROR: 0x0b });

const RESULT_TEXT = Object.freeze({
  0x00: 'Invalid opcode',
  0x01: 'Operation successful',
  0x02: 'Opcode not supported',
  0x03: 'Missing or invalid parameter',
  0x04: 'Insufficient resources',
  0x05: 'Invalid object or firmware',
  0x07: 'Unsupported object type',
  0x08: 'Operation not permitted in the current state',
  0x0a: 'Operation failed',
  0x0b: 'Extended error',
});

const EXTENDED_ERROR_TEXT = Object.freeze({
  0x00: 'No extended error was set',
  0x01: 'Invalid extended error code',
  0x02: 'Incorrect command format',
  0x03: 'Unknown command',
  0x04: 'Invalid init command',
  0x05: 'Firmware version rejected',
  0x06: 'Hardware version mismatch',
  0x07: 'SoftDevice version mismatch',
  0x08: 'Signature missing',
  0x09: 'Unsupported hash type',
  0x0a: 'Firmware hash calculation failed',
  0x0b: 'Unsupported signature type',
  0x0c: 'Firmware hash verification failed',
  0x0d: 'Insufficient flash space',
});

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function withTimeout(promise, timeoutMs, message, onTimeout = null) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch {}
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function crc32(data, seed = 0xffffffff) {
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

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function uint32LE(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

async function writeWithResponse(characteristic, value) {
  if (typeof characteristic.writeValueWithResponse === 'function') {
    return characteristic.writeValueWithResponse(value);
  }
  return characteristic.writeValue(value);
}

async function writeWithoutResponse(characteristic, value) {
  if (typeof characteristic.writeValueWithoutResponse === 'function') {
    return characteristic.writeValueWithoutResponse(value);
  }
  return characteristic.writeValue(value);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof DataView) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return new Uint8Array(value);
}

function characteristicUuid(characteristic) {
  return characteristic.uuid?.toLowerCase?.() ?? String(characteristic.uuid).toLowerCase();
}

export async function discoverDfuService(server) {
  try {
    const service = await server.getPrimaryService(DFU_SERVICE_UUID);
    const characteristics = await service.getCharacteristics();
    const byUuid = uuid => characteristics.find(item => characteristicUuid(item) === uuid);
    return {
      service,
      control: byUuid(DFU_CONTROL_UUID),
      packet: byUuid(DFU_PACKET_UUID),
      buttonless: byUuid(DFU_BUTTONLESS_UUID) || byUuid(DFU_BUTTONLESS_BONDED_UUID),
      characteristics,
    };
  } catch {
    return null;
  }
}

/**
 * Requests the DFU bootloader device. This must be called directly from a user
 * click because Web Bluetooth requires transient user activation.
 */
export function requestDfuDevice(bluetooth = navigator.bluetooth) {
  // The micro:bit V2 DFU identity may be unnamed or may retain the cached
  // BBC micro:bit name after its address changes. The chooser therefore shows
  // all nearby BLE devices. Identity is verified only after connection by
  // requiring Secure DFU control 0001 and packet 0002 characteristics.
  return bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [DFU_SERVICE_UUID],
  });
}

/**
 * Enters buttonless DFU mode. The application device disconnects and advertises
 * again as the bootloader (normally "DfuTarg"). Web Bluetooth usually requires
 * the user to select that device in a second chooser.
 */
export async function enterButtonlessDfu(device, { log = () => {}, timeoutMs = 15000, onCommandAttempt = null } = {}) {
  if (!device) throw new Error('No application device selected');
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const discovered = await discoverDfuService(server);
  if (!discovered?.buttonless) {
    throw new Error('Buttonless DFU characteristic is not available in the installed micro:bit application');
  }

  const button = discovered.buttonless;
  const properties = [
    button.properties.read ? 'read' : null,
    button.properties.write ? 'write' : null,
    button.properties.writeWithoutResponse ? 'writeWithoutResponse' : null,
    button.properties.notify ? 'notify' : null,
    button.properties.indicate ? 'indicate' : null,
  ].filter(Boolean).join(', ') || 'none reported';

  const buttonUuid = characteristicUuid(button);
  const bondedButtonless = buttonUuid === DFU_BUTTONLESS_BONDED_UUID;
  log(`Buttonless DFU characteristic ${buttonUuid} (${properties})${bondedButtonless ? ' — bonded access required' : ''}.`);

  if (!button.properties.write && !button.properties.writeWithoutResponse) {
    throw new Error('Buttonless DFU characteristic is not writable');
  }

  let settled = false;
  let disconnectObserved = false;
  let timer;
  let responseHandler;
  let disconnectHandler;
  let lastWriteError = null;

  const completion = new Promise((resolve, reject) => {
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      button.removeEventListener('characteristicvaluechanged', responseHandler);
      device.removeEventListener('gattserverdisconnected', disconnectHandler);
      if (error) reject(error);
      else resolve();
    };

    responseHandler = event => {
      const data = asBytes(event.target.value);
      // Buttonless response: 0x20, request opcode 0x01, result.
      if (data.length >= 3 && data[0] === 0x20 && data[1] === 0x01) {
        if (data[2] === RESULT.SUCCESS) {
          log('Buttonless DFU command accepted. Waiting for reboot…');
          // The disconnect normally follows immediately. Resolve after a short
          // grace period even if the browser misses the disconnect event.
          setTimeout(() => finish(), 1500);
        } else {
          finish(new Error(`Buttonless DFU rejected: ${RESULT_TEXT[data[2]] || `result 0x${data[2].toString(16)}`}`));
        }
      }
    };

    disconnectHandler = () => {
      disconnectObserved = true;
      log('Application connection closed. Secure DFU mode will be confirmed only after control 0001 and packet 0002 are discovered.');
      finish();
    };

    button.addEventListener('characteristicvaluechanged', responseHandler);
    device.addEventListener('gattserverdisconnected', disconnectHandler);
    timer = setTimeout(() => {
      const detail = lastWriteError ? ` Last GATT error: ${lastWriteError.message}.` : '';
      finish(new Error(`Timed out waiting for the micro:bit to enter DFU mode.${detail}`));
    }, timeoutMs);
  });

  // On bonded micro:bit V2 firmware, requesting indications may trigger a
  // browser or operating-system Bluetooth authorization prompt. Await that
  // single request. Do not open a webpage modal or second Bluetooth chooser at
  // the same time, and do not repeat the CCCD request.
  if (button.properties.notify || button.properties.indicate) {
    try {
      log('Requesting bonded DFU authorization from the Bluetooth stack…');
      await button.startNotifications();
    } catch (error) {
      log(`Buttonless notification subscription was not available: ${error.message}. Sending the reboot command once and waiting for the disconnect.`, 'warn');
    }
  }

  onCommandAttempt?.();
  log('Sending buttonless DFU command once…');
  const command = Uint8Array.of(0x01);

  try {
    if (button.properties.write) {
      await writeWithResponse(button, command);
    } else {
      await writeWithoutResponse(button, command);
    }
  } catch (error) {
    lastWriteError = error;
    // A browser or operating-system Bluetooth stack may reject the write promise
    // while the micro:bit has already accepted the command. Do not retry: a retry can overlap authorization or
    // race the reboot. Wait for the definitive application disconnect instead.
    log(`The browser reported a secured-write error (${error.message}). Waiting for the reboot disconnect; no retry will be sent.`, 'warn');
  }

  if (!device.gatt.connected || disconnectObserved) {
    return completion;
  }

  return completion;
}

function isUnsupportedDeviceError(error) {
  return /^Unsupported device\.?$/i.test(String(error?.message || '').trim());
}

function unsupportedCandidateError() {
  const error = new Error('Unsupported device. The selected browser entry is not GATT-connectable. Reopen the selector and choose another newly discovered entry.');
  error.code = 'DFU_CANDIDATE_UNSUPPORTED';
  return error;
}

export class NordicSecureDfu {
  constructor({
    log = () => {},
    progress = () => {},
    packetSize = 20,
    packetDelayMs = 2,
    controlTimeoutMs = 12000,
    connectionTimeoutMs = 10000,
    discoveryTimeoutMs = 8000,
    notificationTimeoutMs = 8000,
    connectionReadinessDelaysMs = [2000, 3000, 5000],
  } = {}) {
    this.log = log;
    this.progress = progress;
    this.packetSize = packetSize;
    this.packetDelayMs = packetDelayMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.notificationTimeoutMs = notificationTimeoutMs;
    this.connectionReadinessDelaysMs = Array.isArray(connectionReadinessDelaysMs) && connectionReadinessDelaysMs.length
      ? connectionReadinessDelaysMs.map(value => Math.max(0, Number(value) || 0))
      : [2000, 3000, 5000];
    this.connectionAttempts = this.connectionReadinessDelaysMs.length;
    this.device = null;
    this.control = null;
    this.packet = null;
    this.pendingControl = null;
    this.notificationHandler = this.handleNotification.bind(this);
  }

  async connectGatt(device) {
    if (device.gatt.connected) return device.gatt;

    const label = device.name || 'unnamed / unknown device';
    let lastError = null;
    for (let attempt = 1; attempt <= this.connectionAttempts; attempt++) {
      const readinessDelayMs = this.connectionReadinessDelaysMs[attempt - 1] ?? 0;
      if (readinessDelayMs > 0) {
        this.log(`Selected ${label}. Waiting ${Math.round(readinessDelayMs / 1000)} second${readinessDelayMs === 1000 ? '' : 's'} for the newly discovered Bluetooth identity to become GATT-ready (attempt ${attempt}/${this.connectionAttempts})…`);
        await sleep(readinessDelayMs);
      }

      this.log(`Connecting to selected DFU candidate ${label} (attempt ${attempt}/${this.connectionAttempts})…`);
      try {
        const server = await withTimeout(
          device.gatt.connect(),
          this.connectionTimeoutMs,
          `Timed out connecting to the selected Bluetooth device after ${Math.round(this.connectionTimeoutMs / 1000)} seconds`,
          () => device.gatt.disconnect(),
        );
        this.log(`Bluetooth GATT connected to ${label}. Discovering Nordic Secure DFU service…`);
        return server;
      } catch (error) {
        lastError = error;
        try { device.gatt.disconnect(); } catch {}

        if (isUnsupportedDeviceError(error)) {
          this.log('The browser returned “Unsupported device”. This browser entry is not GATT-connectable, so no repeated connection attempts will be made.', 'warn');
          throw unsupportedCandidateError();
        }

        if (attempt < this.connectionAttempts) {
          const nextDelayMs = this.connectionReadinessDelaysMs[attempt] ?? 0;
          this.log(`DFU candidate connection did not complete: ${error.message}. The next transient-error attempt will wait ${Math.round(nextDelayMs / 1000)} seconds.`, 'warn');
        }
      }
    }

    throw new Error(`${lastError?.message || 'Could not connect to the selected Bluetooth device'}. The selected entry did not establish a GATT connection after ${this.connectionAttempts} paced attempts. Keep the prepared DFU package and select another newly discovered entry.`);
  }

  async connect(device) {
    if (!device) throw new Error('No DFU bootloader device selected');
    this.device = device;
    const server = await this.connectGatt(device);
    const discovered = await withTimeout(
      discoverDfuService(server),
      this.discoveryTimeoutMs,
      `Timed out discovering Nordic Secure DFU service 0xFE59 after ${Math.round(this.discoveryTimeoutMs / 1000)} seconds`,
      () => device.gatt.disconnect(),
    );
    if (!discovered?.control || !discovered?.packet) {
      const visible = discovered?.characteristics?.map(characteristicUuid).join(', ') || 'none';
      if (discovered?.buttonless) {
        throw new Error(`Selected entry is still exposing application Buttonless DFU instead of the Secure DFU bootloader. Visible 0xFE59 characteristics: ${visible}`);
      }
      throw new Error(`Selected entry does not expose Secure DFU control 0001 and packet 0002. Visible 0xFE59 characteristics: ${visible}`);
    }

    this.control = discovered.control;
    this.packet = discovered.packet;
    if (!this.control.properties.notify && !this.control.properties.indicate) {
      throw new Error('DFU control characteristic does not support notifications');
    }

    this.log('Secure DFU control 0001 and packet 0002 verified. Enabling DFU responses…');
    await withTimeout(
      this.control.startNotifications(),
      this.notificationTimeoutMs,
      `Timed out enabling Secure DFU notifications after ${Math.round(this.notificationTimeoutMs / 1000)} seconds`,
      () => device.gatt.disconnect(),
    );
    this.control.removeEventListener('characteristicvaluechanged', this.notificationHandler);
    this.control.addEventListener('characteristicvaluechanged', this.notificationHandler);
    this.log(`Connected to ${device.name || 'DFU bootloader'} Secure DFU service.`);
  }

  disconnect() {
    try {
      this.control?.removeEventListener('characteristicvaluechanged', this.notificationHandler);
      this.device?.gatt?.disconnect();
    } catch {}
    this.control = null;
    this.packet = null;
    this.device = null;
    if (this.pendingControl) {
      this.pendingControl.reject(new Error('DFU device disconnected'));
      this.pendingControl = null;
    }
  }

  handleNotification(event) {
    const bytes = asBytes(event.target.value);
    if (bytes.length < 3 || bytes[0] !== OP.RESPONSE) return;
    const requestOpcode = bytes[1];
    const result = bytes[2];
    const pending = this.pendingControl;
    if (!pending || pending.opcode !== requestOpcode) return;

    clearTimeout(pending.timer);
    this.pendingControl = null;

    if (result === RESULT.SUCCESS) {
      pending.resolve(bytes.slice(3));
      return;
    }

    if (result === RESULT.EXTENDED_ERROR && bytes.length >= 4) {
      const code = bytes[3];
      pending.reject(new Error(`DFU extended error 0x${code.toString(16).padStart(2, '0')}: ${EXTENDED_ERROR_TEXT[code] || 'Unknown extended error'}`));
      return;
    }

    pending.reject(new Error(`DFU error 0x${result.toString(16).padStart(2, '0')}: ${RESULT_TEXT[result] || 'Unknown result'}`));
  }

  async sendControl(opcode, payload = new Uint8Array()) {
    if (!this.control) throw new Error('DFU control characteristic is not connected');
    if (this.pendingControl) throw new Error('A DFU control operation is already pending');

    const value = concatBytes(Uint8Array.of(opcode), payload);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingControl?.opcode === opcode) this.pendingControl = null;
        reject(new Error(`Timed out waiting for DFU opcode 0x${opcode.toString(16)}`));
      }, this.controlTimeoutMs);
      this.pendingControl = { opcode, resolve, reject, timer };
    });

    try {
      await writeWithResponse(this.control, value);
    } catch (error) {
      clearTimeout(this.pendingControl?.timer);
      this.pendingControl = null;
      throw error;
    }
    return response;
  }

  async selectObject(type) {
    const response = await this.sendControl(OP.SELECT, Uint8Array.of(type));
    if (response.length < 12) throw new Error('Short DFU Select response');
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    return {
      maxSize: view.getUint32(0, true),
      offset: view.getUint32(4, true),
      crc: view.getUint32(8, true),
    };
  }

  async createObject(type, size) {
    await this.sendControl(OP.CREATE, concatBytes(Uint8Array.of(type), uint32LE(size)));
  }

  async checksum() {
    const response = await this.sendControl(OP.CRC);
    if (response.length < 8) throw new Error('Short DFU CRC response');
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    return {
      offset: view.getUint32(0, true),
      crc: view.getUint32(4, true),
    };
  }

  async execute() {
    await this.sendControl(OP.EXECUTE);
  }

  async writePackets(data, baseOffset, type) {
    for (let offset = 0; offset < data.length; offset += this.packetSize) {
      const end = Math.min(offset + this.packetSize, data.length);
      await writeWithoutResponse(this.packet, data.slice(offset, end));
      const written = baseOffset + end;
      this.progress({ type, currentBytes: written });

      if (this.packetDelayMs > 0) await sleep(this.packetDelayMs);
      else if (((offset / this.packetSize) & 0x0f) === 0x0f) await sleep(0);
    }
  }

  verifyPrefix(data, offset, expectedCrc) {
    if (offset < 0 || offset > data.length) return false;
    return crc32(data.slice(0, offset)) === (expectedCrc >>> 0);
  }

  async transferCommand(initPacket) {
    const selected = await this.selectObject(OBJECT.COMMAND);
    this.log(`DFU command object: max ${selected.maxSize} B, offset ${selected.offset}.`);

    if (selected.offset === initPacket.length && this.verifyPrefix(initPacket, selected.offset, selected.crc)) {
      this.log('Matching init packet is already present; skipping command transfer.');
      return;
    }

    if (initPacket.length > selected.maxSize) {
      throw new Error(`Init packet is ${initPacket.length} B but the bootloader accepts ${selected.maxSize} B command objects`);
    }

    await this.createObject(OBJECT.COMMAND, initPacket.length);
    this.progress({ type: 'init', currentBytes: 0, totalBytes: initPacket.length });
    await this.writePackets(initPacket, 0, 'init');
    const checksum = await this.checksum();
    if (checksum.offset !== initPacket.length || !this.verifyPrefix(initPacket, checksum.offset, checksum.crc)) {
      throw new Error('Init packet CRC validation failed');
    }
    await this.execute();
    this.log('Init packet accepted.');
  }

  async transferFirmware(firmware) {
    const selected = await this.selectObject(OBJECT.DATA);
    const maxSize = selected.maxSize;
    if (!maxSize) throw new Error('Bootloader reported a zero-sized data object');

    let offset = selected.offset;
    this.log(`DFU data object: max ${maxSize} B, resume offset ${offset}.`);
    this.progress({ type: 'firmware', currentBytes: offset, totalBytes: firmware.length });

    if (offset > firmware.length || !this.verifyPrefix(firmware, offset, selected.crc)) {
      if (offset !== 0) {
        throw new Error('Bootloader has a partial DFU image with a different CRC. Power-cycle the micro:bit and retry the full flash.');
      }
      offset = 0;
    }

    if (offset === firmware.length) {
      this.log('Firmware bytes are already present; executing image.');
      await this.execute();
      return;
    }

    while (offset < firmware.length) {
      const objectStart = Math.floor(offset / maxSize) * maxSize;
      const objectEnd = Math.min(objectStart + maxSize, firmware.length);

      if (offset === objectStart) {
        await this.createObject(OBJECT.DATA, objectEnd - objectStart);
      } else {
        this.log(`Resuming data object at ${offset} of ${objectEnd}.`);
      }

      await this.writePackets(firmware.slice(offset, objectEnd), offset, 'firmware');
      const checksum = await this.checksum();
      if (checksum.offset !== objectEnd || !this.verifyPrefix(firmware, checksum.offset, checksum.crc)) {
        throw new Error(`Firmware CRC validation failed at byte ${checksum.offset}`);
      }

      await this.execute();
      offset = objectEnd;
      this.log(`Executed ${offset} of ${firmware.length} firmware bytes.`);
    }
  }

  async update(device, initPacket, firmware) {
    if (!(initPacket instanceof Uint8Array) || !initPacket.length) throw new Error('DFU init packet is empty');
    if (!(firmware instanceof Uint8Array) || !firmware.length) throw new Error('DFU firmware image is empty');

    try {
      await this.connect(device);
      await this.transferCommand(initPacket);
      await this.transferFirmware(firmware);
      this.progress({ type: 'complete', currentBytes: firmware.length, totalBytes: firmware.length });
      this.log('Secure DFU transfer completed. The micro:bit is validating and restarting.');
    } finally {
      // Also clean up when connection or service discovery fails. Without this,
      // a selected unrelated device can leave a pending GATT link and make the
      // page appear permanently stuck.
      await sleep(300);
      this.disconnect();
    }
  }
}
