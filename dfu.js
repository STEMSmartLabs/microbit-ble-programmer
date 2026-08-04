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

function uint16LE(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
  return bytes;
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
 * Completes the bonded authorization phase without sending the DFU reboot
 * command. On micro:bit V2, enabling indications on the bonded Buttonless DFU
 * characteristic can trigger the platform pairing flow. Pairing may display a
 * tick and restart the installed application. The caller must reconnect before
 * sending the actual reboot command.
 */
export async function authorizeBondedButtonlessDfu(device, {
  log = () => {},
  timeoutMs = 8000,
} = {}) {
  if (!device) throw new Error('No application device selected');
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const discovered = await discoverDfuService(server);
  if (!discovered?.buttonless) {
    throw new Error('Buttonless DFU characteristic is not available in the installed micro:bit application');
  }

  const button = discovered.buttonless;
  const buttonUuid = characteristicUuid(button);
  const bonded = buttonUuid === DFU_BUTTONLESS_BONDED_UUID;
  if (!bonded) {
    log('The application exposes non-bonded Buttonless DFU; no separate Bluetooth pairing phase is required.');
    return {
      bonded: false,
      verified: true,
      disconnected: false,
      notificationsStarted: false,
      error: null,
    };
  }

  if (!button.properties.notify && !button.properties.indicate) {
    log('The bonded Buttonless DFU characteristic cannot prove authorization because it exposes no indication or notification property.', 'warn');
    return {
      bonded: true,
      verified: false,
      disconnected: false,
      notificationsStarted: false,
      error: new Error('Bonded DFU authorization cannot be verified on this characteristic'),
    };
  }

  let disconnectHandler;
  let disconnectObserved = false;
  const disconnected = new Promise(resolve => {
    disconnectHandler = () => {
      disconnectObserved = true;
      resolve(true);
    };
    device.addEventListener('gattserverdisconnected', disconnectHandler);
  });

  try {
    log('Requesting Bluetooth pairing/authorization only. The DFU reboot command will not be sent during this phase.');
    try {
      await button.startNotifications();
      log('Bluetooth authorization verified on the current host. Waiting briefly in case pairing restarts the application…');
      const restartObserved = await Promise.race([
        disconnected.then(() => true),
        sleep(2500).then(() => false),
      ]);
      return {
        bonded: true,
        verified: true,
        disconnected: restartObserved || !device.gatt.connected,
        notificationsStarted: !restartObserved && device.gatt.connected,
        error: null,
      };
    } catch (authorizationError) {
      log(`The authorization request reported “${authorizationError.message}”. A disconnect alone will not be treated as proof that the bond succeeded.`, 'warn');

      if (!device.gatt.connected || disconnectObserved) {
        return {
          bonded: true,
          verified: false,
          disconnected: true,
          notificationsStarted: false,
          error: authorizationError,
        };
      }

      try {
        await withTimeout(
          disconnected,
          timeoutMs,
          'Timed out waiting for a pairing restart after the authorization error',
        );
        return {
          bonded: true,
          verified: false,
          disconnected: true,
          notificationsStarted: false,
          error: authorizationError,
        };
      } catch {
        return {
          bonded: true,
          verified: false,
          disconnected: false,
          notificationsStarted: false,
          error: authorizationError,
        };
      }
    }
  } finally {
    device.removeEventListener('gattserverdisconnected', disconnectHandler);
  }
}

/**
 * Enters buttonless DFU mode. The application device disconnects and advertises
 * again as the bootloader (normally "DfuTarg"). Web Bluetooth usually requires
 * the user to select that device in a second chooser.
 */
export async function enterButtonlessDfu(device, {
  log = () => {},
  timeoutMs = 15000,
  onCommandAttempt = null,
  skipAuthorization = false,
  authorizationVerified = false,
} = {}) {
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

  let verified = authorizationVerified || !bondedButtonless;

  if (!skipAuthorization && bondedButtonless && (button.properties.notify || button.properties.indicate)) {
    try {
      log('Verifying bonded DFU authorization on the current connection…');
      await button.startNotifications();
      verified = true;
      log('Bonded DFU authorization verified.');
    } catch (error) {
      verified = false;
      if (!device.gatt.connected) {
        const restartError = new Error('Bluetooth pairing restarted the application before the DFU command was sent');
        restartError.code = 'DFU_AUTHORIZATION_RESTART';
        restartError.cause = error;
        throw restartError;
      }
      log(`Bonded DFU authorization could not be verified: ${error.message}.`, 'warn');
    }
  } else if (skipAuthorization && verified) {
    log('Using the Bluetooth bond verified during the separate authorization phase.');
  } else if (skipAuthorization) {
    log('Bluetooth bond verification was inconclusive. Testing the secured DFU command once; a disconnect alone will remain an uncertain outcome.', 'warn');
  }

  let settled = false;
  let disconnectObserved = false;
  let commandAccepted = false;
  let writeSucceeded = false;
  let timer;
  let responseHandler;
  let disconnectHandler;
  let lastWriteError = null;

  const currentOutcome = () => ({
    authorizationVerified: verified,
    commandAccepted,
    writeSucceeded,
    disconnected: disconnectObserved,
    writeError: lastWriteError,
  });

  const completion = new Promise((resolve, reject) => {
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      button.removeEventListener('characteristicvaluechanged', responseHandler);
      device.removeEventListener('gattserverdisconnected', disconnectHandler);
      const outcome = currentOutcome();
      if (error) {
        error.outcome = outcome;
        reject(error);
      } else {
        resolve(outcome);
      }
    };

    responseHandler = event => {
      const data = asBytes(event.target.value);
      if (data.length >= 3 && data[0] === 0x20 && data[1] === 0x01) {
        if (data[2] === RESULT.SUCCESS) {
          commandAccepted = true;
          log('Buttonless DFU command accepted. Waiting for reboot…');
          setTimeout(() => finish(), 1500);
        } else {
          finish(new Error(`Buttonless DFU rejected: ${RESULT_TEXT[data[2]] || `result 0x${data[2].toString(16)}`}`));
        }
      }
    };

    disconnectHandler = () => {
      disconnectObserved = true;
      log('Application connection closed after the DFU command attempt. The command outcome will be classified before DFU selection is enabled.');
      // Let a pending write promise settle so the returned outcome records
      // whether the secured write itself succeeded or failed.
      setTimeout(() => finish(), 250);
    };

    button.addEventListener('characteristicvaluechanged', responseHandler);
    device.addEventListener('gattserverdisconnected', disconnectHandler);
    timer = setTimeout(() => {
      const detail = lastWriteError ? ` Last GATT error: ${lastWriteError.message}.` : '';
      const error = new Error(`Timed out waiting for the micro:bit to enter DFU mode.${detail}`);
      error.code = 'DFU_ENTRY_TIMEOUT';
      finish(error);
    }, timeoutMs);
  });

  onCommandAttempt?.();
  log('Sending buttonless DFU command once…');
  const command = Uint8Array.of(0x01);

  try {
    if (button.properties.write) {
      await writeWithResponse(button, command);
    } else {
      await writeWithoutResponse(button, command);
    }
    writeSucceeded = true;
    log('The secured Buttonless DFU write completed. Waiting for the command response or reboot…');
  } catch (error) {
    lastWriteError = error;
    log(`The browser reported a secured-write error (${error.message}). Waiting only for a possible reboot disconnect; no retry will be sent.`, 'warn');
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
    packetDelayMs = 4,
    packetReceiptInterval = 12,
    receiptTimeoutMs = 10000,
    objectDrainDelayMs = 150,
    recoveryPacketDelayMs = 10,
    maxTailRecoveryAttempts = 2,
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
    this.packetReceiptInterval = Math.max(0, Math.floor(Number(packetReceiptInterval) || 0));
    this.receiptTimeoutMs = Math.max(1000, Number(receiptTimeoutMs) || 10000);
    this.objectDrainDelayMs = Math.max(0, Number(objectDrainDelayMs) || 0);
    this.recoveryPacketDelayMs = Math.max(this.packetDelayMs, Number(recoveryPacketDelayMs) || this.packetDelayMs);
    this.maxTailRecoveryAttempts = Math.max(0, Math.floor(Number(maxTailRecoveryAttempts) || 0));
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
    this.pendingReceipt = null;
    this.lastConfiguredPrn = null;
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
        const error = new Error(`Selected entry is still exposing application Buttonless DFU instead of the Secure DFU bootloader. Visible 0xFE59 characteristics: ${visible}`);
        error.code = 'DFU_CANDIDATE_APPLICATION';
        throw error;
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
    this.lastConfiguredPrn = null;
    if (this.pendingControl) {
      clearTimeout(this.pendingControl.timer);
      this.pendingControl.reject(new Error('DFU device disconnected'));
      this.pendingControl = null;
    }
    this.rejectPendingReceipt(new Error('DFU device disconnected'));
  }

  handleNotification(event) {
    const bytes = asBytes(event.target.value);
    if (bytes.length < 3 || bytes[0] !== OP.RESPONSE) return;
    const requestOpcode = bytes[1];
    const result = bytes[2];
    const pending = this.pendingControl;

    // Direct responses to a control operation always take precedence. Packet
    // Receipt Notifications use the Calculate CRC response opcode (0x03), but
    // arrive while no Calculate CRC control operation is pending.
    if (pending && pending.opcode === requestOpcode) {
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
      return;
    }

    if (requestOpcode !== OP.CRC || !this.pendingReceipt) return;
    const receipt = this.pendingReceipt;
    clearTimeout(receipt.timer);
    this.pendingReceipt = null;

    if (result !== RESULT.SUCCESS) {
      const error = new Error(`DFU packet receipt failed with result 0x${result.toString(16).padStart(2, '0')}`);
      error.code = 'DFU_PRN_ERROR';
      receipt.reject(error);
      return;
    }
    if (bytes.length < 11) {
      const error = new Error('Short DFU Packet Receipt Notification');
      error.code = 'DFU_PRN_ERROR';
      receipt.reject(error);
      return;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset + 3, bytes.byteLength - 3);
    const offset = view.getUint32(0, true);
    const crc = view.getUint32(4, true);
    if (offset !== receipt.expectedOffset || crc !== receipt.expectedCrc) {
      const error = new Error(`DFU packet receipt mismatch: expected offset ${receipt.expectedOffset} CRC 0x${receipt.expectedCrc.toString(16).padStart(8, '0')}, received offset ${offset} CRC 0x${crc.toString(16).padStart(8, '0')}`);
      error.code = 'DFU_PRN_MISMATCH';
      error.offset = offset;
      error.crc = crc;
      receipt.reject(error);
      return;
    }
    receipt.resolve({ offset, crc });
  }

  rejectPendingReceipt(error) {
    if (!this.pendingReceipt) return;
    const receipt = this.pendingReceipt;
    clearTimeout(receipt.timer);
    this.pendingReceipt = null;
    receipt.reject(error);
  }

  waitForPacketReceipt(expectedOffset, expectedCrc) {
    if (this.pendingReceipt) throw new Error('A DFU Packet Receipt Notification is already pending');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingReceipt?.expectedOffset === expectedOffset) this.pendingReceipt = null;
        const error = new Error(`Timed out waiting for DFU packet receipt at byte ${expectedOffset}`);
        error.code = 'DFU_PRN_TIMEOUT';
        error.offset = expectedOffset;
        reject(error);
      }, this.receiptTimeoutMs);
      this.pendingReceipt = { expectedOffset, expectedCrc: expectedCrc >>> 0, resolve, reject, timer };
    });
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

  async setPacketReceiptNotifications(interval, { announce = false } = {}) {
    const normalized = Math.max(0, Math.min(0xffff, Math.floor(Number(interval) || 0)));
    await this.sendControl(OP.SET_PRN, uint16LE(normalized));
    if (announce || this.lastConfiguredPrn !== normalized) {
      if (normalized > 0) {
        this.log(`DFU flow control enabled: validating every ${normalized} data packets with Packet Receipt Notifications.`);
      } else {
        this.log('DFU Packet Receipt Notifications disabled for the init packet.');
      }
    }
    this.lastConfiguredPrn = normalized;
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

  async writePackets(data, baseOffset, type, {
    verificationData = null,
    receiptInterval = 0,
    packetDelayMs = this.packetDelayMs,
  } = {}) {
    let packetsSinceReceipt = 0;
    for (let offset = 0; offset < data.length; offset += this.packetSize) {
      const end = Math.min(offset + this.packetSize, data.length);
      const written = baseOffset + end;
      packetsSinceReceipt++;
      const receiptDue = Boolean(
        receiptInterval > 0
        && verificationData
        && packetsSinceReceipt >= receiptInterval
      );
      const receiptPromise = receiptDue
        ? this.waitForPacketReceipt(written, crc32(verificationData.slice(0, written)))
        : null;

      try {
        await writeWithoutResponse(this.packet, data.slice(offset, end));
      } catch (error) {
        this.rejectPendingReceipt(error);
        throw error;
      }
      this.progress({ type, currentBytes: written });

      if (receiptPromise) {
        await receiptPromise;
        packetsSinceReceipt = 0;
      }

      if (packetDelayMs > 0) await sleep(packetDelayMs);
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

    await this.setPacketReceiptNotifications(0);
    await this.createObject(OBJECT.COMMAND, initPacket.length);
    this.progress({ type: 'init', currentBytes: 0, totalBytes: initPacket.length });
    await this.writePackets(initPacket, 0, 'init');
    if (this.objectDrainDelayMs > 0) await sleep(this.objectDrainDelayMs);
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

    let announcedPrn = false;
    while (offset < firmware.length) {
      const objectStart = Math.floor(offset / maxSize) * maxSize;
      const objectEnd = Math.min(objectStart + maxSize, firmware.length);

      if (offset === objectStart) {
        await this.createObject(OBJECT.DATA, objectEnd - objectStart);
      } else {
        this.log(`Resuming data object at ${offset} of ${objectEnd}.`);
      }

      let sendOffset = offset;
      let recoveryAttempt = 0;
      while (sendOffset < objectEnd) {
        const recoveringTail = recoveryAttempt > 0;
        const receiptInterval = recoveringTail ? 1 : this.packetReceiptInterval;
        await this.setPacketReceiptNotifications(receiptInterval, { announce: !announcedPrn || recoveringTail });
        announcedPrn = true;

        await this.writePackets(
          firmware.slice(sendOffset, objectEnd),
          sendOffset,
          'firmware',
          {
            verificationData: firmware,
            receiptInterval,
            packetDelayMs: recoveringTail ? this.recoveryPacketDelayMs : this.packetDelayMs,
          },
        );

        // writeValueWithoutResponse resolves when the browser accepts a packet
        // for transmission, not necessarily after the controller has delivered
        // it. Give the final queued writes time to drain before asking the
        // bootloader to calculate its CRC.
        if (this.objectDrainDelayMs > 0) await sleep(this.objectDrainDelayMs);
        const checksum = await this.checksum();
        const prefixMatches = this.verifyPrefix(firmware, checksum.offset, checksum.crc);

        if (checksum.offset === objectEnd && prefixMatches) {
          sendOffset = objectEnd;
          break;
        }

        if (!prefixMatches) {
          throw new Error(`Firmware CRC mismatch at byte ${checksum.offset}: the received data does not match the firmware prefix`);
        }
        if (checksum.offset < sendOffset || checksum.offset > objectEnd) {
          throw new Error(`Unexpected DFU firmware offset ${checksum.offset}; expected ${sendOffset}–${objectEnd}`);
        }

        recoveryAttempt++;
        if (recoveryAttempt > this.maxTailRecoveryAttempts) {
          throw new Error(`Firmware transfer remained short at byte ${checksum.offset} after ${this.maxTailRecoveryAttempts} recovery attempt${this.maxTailRecoveryAttempts === 1 ? '' : 's'}`);
        }

        const missing = objectEnd - checksum.offset;
        this.log(`Bootloader validated ${checksum.offset} bytes but the current object ends at ${objectEnd}; retransmitting the missing ${missing} byte${missing === 1 ? '' : 's'} with per-packet receipts.`, 'warn');
        sendOffset = checksum.offset;
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
