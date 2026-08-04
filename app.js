import {
  DEFAULT_V2_FLASH_USABLE_END,
  V2_APPLICATION_START,
  V2_FLASH_END,
  createMicrobitV2InitPacket,
  formatBytes,
  formatHexAddress,
  prepareFirmware,
  selectMarkerCandidate,
  toHex,
} from './core.js';
import {
  DFU_SERVICE_UUID,
  NordicSecureDfu,
  discoverDfuService,
  enterButtonlessDfu,
  requestDfuDevice,
} from './dfu.js?v=2.2.7';

const APP_VERSION = '2.2.7';
const PARTIAL_SERVICE_UUID = 'e97dd91d-251d-470a-a062-fa1922dfa9a8';
const PARTIAL_CHARACTERISTIC_UUID = 'e97d3b10-251d-470a-a062-fa1922dfa9a8';
const PARTIAL_BLOCK_SIZE = 64;
const PARTIAL_PACKETS_PER_BLOCK = 4;
const PARTIAL_PACKET_DATA_SIZE = 16;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const el = id => document.getElementById(id);

let applicationDevice = null;
let partialCharacteristic = null;
let buttonlessAvailable = false;
let preparedFirmware = null;
let selectedFileName = '';
let flashInProgress = false;
const DISCONNECT_PHASE = Object.freeze({
  NONE: 'none',
  MODE_SWITCH: 'mode-switch',
  DFU_HANDOFF: 'dfu-handoff',
});
let disconnectPhase = DISCONNECT_PHASE.NONE;
let buttonlessDfuCommandAttempted = false;
let pendingDfu = null;
let dfuChooserReady = false;
let applicationDeviceIdBeforeDfu = null;
const unsupportedDfuCandidateIds = new Set();
let wakeLock = null;
let notificationQueue = [];
let notificationWaiters = [];
let lastProgressLogPercent = -10;

function log(message, level = 'info') {
  const stamp = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const prefix = level === 'error' ? 'ERROR: ' : level === 'warn' ? 'WARNING: ' : '';
  const status = el('status');
  status.textContent += `\n[${stamp}] ${prefix}${message}`;
  status.scrollTop = status.scrollHeight;
}

function setState(id, text, state = '') {
  const target = el(id);
  if (!target) return;
  target.textContent = text;
  target.dataset.state = state;
}

function readU32BE(bytes, offset) {
  if (bytes.length < offset + 4) throw new Error('Short response from micro:bit');
  return (((bytes[offset] << 24) >>> 0)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]) >>> 0;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function clearNotificationState(error = new Error('Bluetooth disconnected')) {
  for (const waiter of notificationWaiters.splice(0)) waiter.reject(error);
  notificationQueue = [];
}

function handlePartialNotification(event) {
  const view = event.target.value;
  const data = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  const waiterIndex = notificationWaiters.findIndex(waiter => waiter.predicate(data));
  if (waiterIndex >= 0) {
    const [waiter] = notificationWaiters.splice(waiterIndex, 1);
    waiter.resolve(data);
  } else {
    notificationQueue.push(data);
    if (notificationQueue.length > 32) notificationQueue.shift();
  }
}

function createNotificationWaiter(predicate, timeoutMs = 5000) {
  const queuedIndex = notificationQueue.findIndex(predicate);
  if (queuedIndex >= 0) {
    const value = notificationQueue.splice(queuedIndex, 1)[0];
    return { promise: Promise.resolve(value), cancel: () => {}, isSettled: () => true };
  }

  let settled = false;
  let timer;
  let waiter;
  const promise = new Promise((resolve, reject) => {
    waiter = {
      predicate,
      resolve: value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      reject: error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    };
    notificationWaiters.push(waiter);
    timer = setTimeout(() => {
      const index = notificationWaiters.indexOf(waiter);
      if (index >= 0) notificationWaiters.splice(index, 1);
      waiter.reject(new Error('Timed out waiting for micro:bit response'));
    }, timeoutMs);
  });

  return {
    promise,
    cancel: error => {
      const index = notificationWaiters.indexOf(waiter);
      if (index >= 0) notificationWaiters.splice(index, 1);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    },
    isSettled: () => settled,
  };
}

async function writePartialPacket(bytes) {
  if (!partialCharacteristic) throw new Error('Partial Programming Service is not connected');
  const packet = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (typeof partialCharacteristic.writeValueWithoutResponse === 'function') {
    await partialCharacteristic.writeValueWithoutResponse(packet);
  } else {
    await partialCharacteristic.writeValue(packet);
  }
}

function discardQueuedNotifications(predicate) {
  notificationQueue = notificationQueue.filter(data => !predicate(data));
}

async function partialCommand(bytes, predicate, timeoutMs = 5000) {
  discardQueuedNotifications(predicate);
  const waiter = createNotificationWaiter(predicate, timeoutMs);
  try {
    await writePartialPacket(bytes);
    return await waiter.promise;
  } catch (error) {
    waiter.cancel(error);
    throw error;
  }
}

async function attachApplicationServices() {
  if (!applicationDevice) throw new Error('No Bluetooth device selected');
  const server = applicationDevice.gatt.connected
    ? applicationDevice.gatt
    : await applicationDevice.gatt.connect();

  partialCharacteristic = null;
  buttonlessAvailable = false;
  clearNotificationState(new Error('Refreshing Bluetooth services'));

  try {
    const partialService = await server.getPrimaryService(PARTIAL_SERVICE_UUID);
    partialCharacteristic = await partialService.getCharacteristic(PARTIAL_CHARACTERISTIC_UUID);
    partialCharacteristic.removeEventListener('characteristicvaluechanged', handlePartialNotification);
    partialCharacteristic.addEventListener('characteristicvaluechanged', handlePartialNotification);
    await partialCharacteristic.startNotifications();
  } catch {
    partialCharacteristic = null;
  }

  const dfu = await discoverDfuService(server);
  buttonlessAvailable = Boolean(dfu?.buttonless);

  if (!partialCharacteristic && !buttonlessAvailable) {
    throw new Error('Neither the Partial Programming Service nor Buttonless DFU is available in this micro:bit program');
  }

  if (partialCharacteristic && buttonlessAvailable) {
    setState('serviceState', 'Partial + Full DFU', 'good');
  } else if (partialCharacteristic) {
    setState('serviceState', 'Partial only', 'warn');
  } else {
    setState('serviceState', 'Full DFU only', 'good');
  }
}

function updateButtons() {
  const connected = Boolean(applicationDevice?.gatt?.connected && (partialCharacteristic || buttonlessAvailable));
  el('connect').disabled = flashInProgress;
  el('program').disabled = flashInProgress || Boolean(pendingDfu) || !connected || !preparedFirmware;
  el('disconnect').disabled = flashInProgress || !applicationDevice?.gatt?.connected;
  el('hexFile').disabled = flashInProgress;
  el('selectDfu').hidden = !pendingDfu;
  el('selectDfu').disabled = flashInProgress || !pendingDfu || !dfuChooserReady;
  el('cancelDfu').hidden = !pendingDfu;
  el('cancelDfu').disabled = flashInProgress || !pendingDfu;

}

function showDfuHandoffDialog() {
  // Intentionally no modal dialog here. A page-level modal can overlap a
  // browser or operating-system Bluetooth authorization prompt and cause one
  // of the two interfaces to close. The inline DFU button is enabled only after
  // the application-mode micro:bit has actually disconnected.
}

function markDfuChooserReady() {
  if (!pendingDfu) return;
  dfuChooserReady = true;
  setState('connectionState', 'Waiting for DFU device', 'busy');
  setState('modeState', 'DFU not confirmed', 'busy');
  el('progressText').textContent = 'Open the DFU selector and wait for the rebooted micro:bit identity to appear';
  updateButtons();
  // Web Bluetooth requires a fresh user gesture for the second chooser.
  // Focusing the inline button removes avoidable delay without opening another
  // page interface while Bluetooth authorization may still be active.
  queueMicrotask(() => {
    const button = el('selectDfu');
    button?.focus({ preventScroll: false });
  });
}

function handleApplicationDisconnected() {
  const phase = disconnectPhase;
  partialCharacteristic = null;
  buttonlessAvailable = false;
  clearNotificationState();

  if (phase === DISCONNECT_PHASE.MODE_SWITCH) {
    setState('connectionState', 'Reconnecting in programming mode', 'busy');
    setState('modeState', 'Mode switch in progress', 'busy');
    log('Application disconnected while switching to pairing/programming mode. The DFU selector remains disabled.');
  } else if (
    phase === DISCONNECT_PHASE.DFU_HANDOFF
    && buttonlessDfuCommandAttempted
    && pendingDfu
  ) {
    log('Application disconnected after the Buttonless DFU command attempt. Secure DFU is not yet confirmed; enabling the DFU selector.');
    markDfuChooserReady();
  } else {
    setState('connectionState', 'Disconnected', 'neutral');
    setState('modeState', 'Unknown', 'neutral');
    setState('serviceState', 'Not checked', 'neutral');
    log(pendingDfu
      ? 'Application disconnected, but no Buttonless DFU command attempt was active. The DFU selector remains disabled.'
      : 'Disconnected.');
  }
  updateButtons();
}

async function connectApplication() {
  if (!window.isSecureContext) throw new Error('Web Bluetooth requires HTTPS or localhost');
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser');

  if (!applicationDevice) {
    applicationDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [PARTIAL_SERVICE_UUID, DFU_SERVICE_UUID],
    });
    applicationDevice.addEventListener('gattserverdisconnected', handleApplicationDisconnected);
  }

  setState('connectionState', 'Connecting…', 'busy');
  await attachApplicationServices();
  setState('connectionState', applicationDevice.name || 'Connected', 'good');
  setState('modeState', 'Application', 'good');
  setState('runtimeState', 'Not checked', 'neutral');
  setState('methodState', 'Will be selected automatically', 'neutral');
  log(`Connected: ${applicationDevice.name || 'BBC micro:bit'} [browser id ${applicationDevice.id}]`);
  log(`Services: ${partialCharacteristic ? 'partial programming' : ''}${partialCharacteristic && buttonlessAvailable ? ' + ' : ''}${buttonlessAvailable ? 'buttonless full DFU' : ''}.`);
  updateButtons();
}

async function readRegion(regionId) {
  const response = await partialCommand(
    [0x00, regionId],
    data => data[0] === 0x00 && data[1] === regionId,
    5000,
  );
  if (response.length < 18) throw new Error(`Invalid region ${regionId} response: ${toHex(response)}`);
  return {
    start: readU32BE(response, 2),
    end: readU32BE(response, 6),
    hash: toHex(response.slice(10, 18)),
  };
}

function validateDeviceProgramRegion(makeCode) {
  if (makeCode.start < 0 || makeCode.start >= V2_FLASH_END
      || makeCode.end <= makeCode.start || makeCode.end > V2_FLASH_END) {
    throw new Error(`Device reported an unsafe program region ${formatHexAddress(makeCode.start)}–${formatHexAddress(makeCode.end)}`);
  }
  if ((makeCode.start & 0x0f) !== 0) throw new Error('Device program region is not 16-byte aligned');
}

function chooseMarkerForDevice(image, dal, makeCode) {
  return image.markerCandidates.find(candidate => (
    candidate.offset === makeCode.start && candidate.runtimeHash === dal.hash
  )) || image.markerCandidates.find(candidate => candidate.offset === makeCode.start) || null;
}

async function readFlashInfo(image) {
  if (!partialCharacteristic) return null;
  const status = await partialCommand([0xee], data => data[0] === 0xee, 5000);
  if (status.length < 3) throw new Error(`Invalid partial programming status: ${toHex(status)}`);

  const version = status[1];
  const mode = status[2];
  const modeName = mode === 0 ? 'pairing/programming' : mode === 1 ? 'application' : `unknown (${mode})`;
  setState('modeState', modeName, mode <= 1 ? 'good' : 'warn');
  log(`Partial Programming Service v${version}, mode ${modeName}`);

  const dal = await readRegion(0x01);
  const makeCode = await readRegion(0x02);
  validateDeviceProgramRegion(makeCode);

  const candidate = chooseMarkerForDevice(image, dal, makeCode);
  const selectedImage = selectMarkerCandidate(image, candidate);
  const layoutMatches = Boolean(candidate && candidate.offset === makeCode.start);
  const runtimeMatches = Boolean(candidate && candidate.runtimeHash === dal.hash);
  const programMatches = Boolean(candidate && candidate.programHash === makeCode.hash);

  setState('runtimeState', runtimeMatches ? 'Runtime match' : 'Runtime differs', runtimeMatches ? 'good' : 'warn');
  log(`Device runtime hash:    ${dal.hash}`);
  log(`Device program hash:    ${makeCode.hash}`);
  log(`Device program region:  ${formatHexAddress(makeCode.start)}–${formatHexAddress(makeCode.end)} (${formatBytes(makeCode.end - makeCode.start)})`);
  if (candidate) {
    log(`Selected HEX runtime:   ${candidate.runtimeHash}`);
    log(`Selected HEX program:   ${candidate.programHash}`);
    log(`Selected HEX start:     ${formatHexAddress(candidate.offset)}`);
  } else {
    log('No HEX partial-flash marker matches the device program start.', 'warn');
  }

  return {
    version,
    mode,
    dal,
    makeCode,
    candidate,
    image: selectedImage,
    layoutMatches,
    runtimeMatches,
    programMatches,
  };
}

function requestFullDfuApproval(info, firmware, reason) {
  const dialog = el('fullDfuWarningDialog');
  el('fullDfuReason').textContent = reason;
  el('warningHexHash').textContent = info?.candidate?.runtimeHash || firmware.runtimeHash || 'Not available';
  el('warningDeviceHash').textContent = info?.dal?.hash || 'Not available';
  el('fullDfuSize').textContent = `${formatBytes(firmware.applicationBytes)} (${formatHexAddress(firmware.applicationStart)}–${formatHexAddress(firmware.applicationEnd)})`;
  el('fullDfuAcknowledge').checked = false;
  el('confirmFullDfu').disabled = true;

  return new Promise(resolve => {
    const finish = approved => {
      dialog.close();
      cleanup();
      resolve(approved);
    };
    const onCheck = () => { el('confirmFullDfu').disabled = !el('fullDfuAcknowledge').checked; };
    const onCancel = event => { event.preventDefault(); finish(false); };
    const onCancelClick = () => finish(false);
    const onConfirm = () => finish(true);
    const cleanup = () => {
      el('fullDfuAcknowledge').removeEventListener('change', onCheck);
      el('cancelFullDfu').removeEventListener('click', onCancelClick);
      el('confirmFullDfu').removeEventListener('click', onConfirm);
      dialog.removeEventListener('cancel', onCancel);
    };

    el('fullDfuAcknowledge').addEventListener('change', onCheck);
    el('cancelFullDfu').addEventListener('click', onCancelClick);
    el('confirmFullDfu').addEventListener('click', onConfirm);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
  });
}

async function reconnectAfterPartialModeSwitch() {
  disconnectPhase = DISCONNECT_PHASE.MODE_SWITCH;
  try {
    if (applicationDevice?.gatt?.connected) applicationDevice.gatt.disconnect();
    partialCharacteristic = null;
    clearNotificationState(new Error('Switching micro:bit mode'));

    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        await sleep(attempt === 1 ? 900 : 500);
        await attachApplicationServices();
        if (!partialCharacteristic) throw new Error('Partial Programming Service not found');
        setState('connectionState', applicationDevice.name || 'Connected', 'good');
        log(`Reconnected in programming mode (attempt ${attempt}).`);
        return;
      } catch (error) {
        if (attempt === 20) throw new Error(`Could not reconnect in programming mode: ${error.message}`);
      }
    }
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
  }
}

function makePartialDataPacket(image, offset, packetNumber, part) {
  const packet = new Uint8Array(20);
  packet.fill(0xff, 4);
  packet[0] = 0x01;
  packet[3] = (packetNumber + part) & 0xff;

  if (part === 0) {
    packet[1] = (offset >>> 8) & 0xff;
    packet[2] = offset & 0xff;
  } else if (part === 1) {
    packet[1] = (offset >>> 24) & 0xff;
    packet[2] = (offset >>> 16) & 0xff;
  }

  const sourceStart = offset + part * PARTIAL_PACKET_DATA_SIZE;
  packet.set(image.binary.slice(sourceStart, sourceStart + PARTIAL_PACKET_DATA_SIZE), 4);
  return packet;
}

async function sendPartialBlock(image, offset, packetNumber, chunkDelay) {
  discardQueuedNotifications(data => data[0] === 0x01);
  const waiter = createNotificationWaiter(data => data[0] === 0x01, 7000);
  const ackPromise = waiter.promise;

  try {
    for (let part = 0; part < PARTIAL_PACKETS_PER_BLOCK; part++) {
      if (chunkDelay) await sleep(chunkDelay);
      await writePartialPacket(makePartialDataPacket(image, offset, packetNumber, part));
    }

    for (let probe = 0; probe < 8; probe++) {
      const race = await Promise.race([
        ackPromise.then(value => ({ value })),
        sleep(650).then(() => ({ timeout: true })),
      ]);
      if (!race.timeout) return race.value;
      if (waiter.isSettled()) return await ackPromise;
      const bogus = new Uint8Array(20);
      bogus[0] = 0x01;
      bogus[3] = 0xff;
      await writePartialPacket(bogus);
    }
    return await ackPromise;
  } catch (error) {
    waiter.cancel(error);
    throw error;
  }
}

function resetProgress(totalBytes = 0, text = 'Preparing…') {
  el('progress').max = Math.max(1, totalBytes);
  el('progress').value = 0;
  el('progressPercent').textContent = '0%';
  el('progressText').textContent = text;
  el('bytesText').textContent = `0 B / ${formatBytes(totalBytes)}`;
  el('timeText').textContent = 'Elapsed 00:00 · ETA --:--';
  lastProgressLogPercent = -10;
}

function updateProgress(doneBytes, totalBytes, startTime, address, label = 'Writing', forceLog = false) {
  const percent = totalBytes ? Math.min(100, (doneBytes / totalBytes) * 100) : 0;
  const elapsedSeconds = (performance.now() - startTime) / 1000;
  const bytesPerSecond = elapsedSeconds > 0 ? doneBytes / elapsedSeconds : 0;
  const etaSeconds = bytesPerSecond > 0 ? (totalBytes - doneBytes) / bytesPerSecond : Infinity;

  el('progress').max = Math.max(1, totalBytes);
  el('progress').value = Math.min(doneBytes, totalBytes);
  el('progressPercent').textContent = `${Math.floor(percent)}%`;
  el('progressText').textContent = address === null ? label : `${label} ${formatHexAddress(address)}`;
  el('bytesText').textContent = `${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}`;
  el('timeText').textContent = `Elapsed ${formatDuration(elapsedSeconds)} · ETA ${formatDuration(etaSeconds)}`;

  const wholePercent = Math.floor(percent);
  if (forceLog || wholePercent >= lastProgressLogPercent + 10) {
    lastProgressLogPercent = Math.floor(wholePercent / 10) * 10;
    log(`${label}: ${wholePercent}% — ${formatBytes(doneBytes)} of ${formatBytes(totalBytes)}${address === null ? '' : ` — ${formatHexAddress(address)}`}`);
  }
}

async function transferPartial(image, transferEnd) {
  let offset = image.magicOffset;
  let packetNumber = 0;
  let chunkDelay = 15;
  let retriesForBlock = 0;
  const totalBytes = transferEnd - image.magicOffset;
  const startedAt = performance.now();

  resetProgress(totalBytes, 'Starting partial Bluetooth transfer…');
  updateProgress(0, totalBytes, startedAt, offset, 'Partial flash', true);

  while (offset < transferEnd) {
    const ack = await sendPartialBlock(image, offset, packetNumber, chunkDelay);
    if (ack.length < 2) throw new Error(`Short transfer response: ${toHex(ack)}`);

    if (ack[1] === 0xaa) {
      retriesForBlock++;
      if (retriesForBlock > 12) throw new Error(`Packet resynchronisation repeatedly failed at ${formatHexAddress(offset)}`);
      packetNumber = (packetNumber + 4) & 0xff;
      chunkDelay = Math.min(chunkDelay + 10, 75);
      log(`Packet out of order at ${formatHexAddress(offset)}; resync ${retriesForBlock}, delay ${chunkDelay} ms.`, 'warn');
      continue;
    }

    if (ack[1] !== 0xff) throw new Error(`Packet transfer failed, response ${toHex(ack)}`);
    offset += PARTIAL_BLOCK_SIZE;
    packetNumber = (packetNumber + 4) & 0xff;
    retriesForBlock = 0;
    chunkDelay = Math.max(0, chunkDelay - 1);
    updateProgress(offset - image.magicOffset, totalBytes, startedAt, Math.min(offset, transferEnd), 'Partial flash');
  }
  updateProgress(totalBytes, totalBytes, startedAt, transferEnd, 'Partial flash', true);
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (error) {
    log(`Screen wake lock unavailable: ${error.message}`, 'warn');
  }
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}

async function runPartialFlash(info) {
  setState('methodState', 'Fast partial flash', 'good');
  log('Runtime and program layout match. Using fast Partial Programming Service.');

  if (info.mode === 1 && info.programMatches) {
    await writePartialPacket([0xff, 0x01]);
    el('progress').max = 100;
    el('progress').value = 100;
    el('progressPercent').textContent = '100%';
    el('progressText').textContent = 'The selected program is already installed';
    log('Program already installed; micro:bit restarted in application mode.');
    return;
  }

  if (info.mode !== 0) {
    try {
      disconnectPhase = DISCONNECT_PHASE.MODE_SWITCH;
      await writePartialPacket([0xff, 0x00]);
      log('Switching micro:bit to pairing/programming mode…');
      await reconnectAfterPartialModeSwitch();
    } catch (error) {
      disconnectPhase = DISCONNECT_PHASE.NONE;
      throw error;
    }
    info = await readFlashInfo(preparedFirmware);
    if (!info || info.mode !== 0) throw new Error('micro:bit did not enter pairing/programming mode');
    if (!info.runtimeMatches || !info.layoutMatches) throw new Error('Runtime or program layout changed during reconnect');
  }

  const transferEnd = info.makeCode.end;
  const transferBytes = transferEnd - info.image.magicOffset;
  log(`Starting partial transfer of ${formatBytes(transferBytes)} from ${formatHexAddress(info.image.magicOffset)} to ${formatHexAddress(transferEnd)}.`);
  await transferPartial(info.image, transferEnd);
  log('Sending partial-flash end-of-transmission command…');
  await writePartialPacket([0x02]);
  el('progress').value = el('progress').max;
  el('progressPercent').textContent = '100%';
  el('progressText').textContent = 'Partial programming complete — micro:bit restarting';
  log('Partial programming complete.');
}

async function quiescePartialNotificationsBeforeDfu() {
  const partial = partialCharacteristic;
  if (!partial) return;

  clearNotificationState(new Error('Switching from partial flashing to full DFU'));
  partial.removeEventListener('characteristicvaluechanged', handlePartialNotification);

  if (typeof partial.stopNotifications === 'function') {
    try {
      log('Stopping Partial Programming Service notifications before entering DFU…');
      await partial.stopNotifications();
    } catch (error) {
      // Chrome may report an implementation-specific GATT error while tearing
      // down a CCCD. This is non-fatal because the full-DFU path does not use
      // the partial characteristic after this point.
      log(`Could not stop partial-flash notifications cleanly: ${error.message}. Continuing.`, 'warn');
    }
  }

  // Give the browser/SoftDevice GATT operation queue time to settle before a
  // second CCCD operation is attempted on the Buttonless DFU characteristic.
  await sleep(350);
}

async function ensurePairingModeForFullDfu(info) {
  // micro:bit V2 normally exposes the bonded Buttonless DFU characteristic
  // (UUID ending 0004). Partial Programming is accessible without proving the
  // bond, but the DFU CCCD and control write require an encrypted bonded link.
  // Moving into pairing/programming mode allows the browser and operating
  // system Bluetooth stack to create or repair that bond when the secured DFU
  // characteristic is accessed.
  if (!partialCharacteristic || info?.mode === 0) return info;

  el('progressText').textContent = 'Switching micro:bit to pairing mode for secure DFU…';
  setState('modeState', 'entering pairing mode', 'busy');
  log('Switching micro:bit to pairing/programming mode so the browser can establish the DFU bond…');

  try {
    disconnectPhase = DISCONNECT_PHASE.MODE_SWITCH;
    await writePartialPacket([0xff, 0x00]);
    await reconnectAfterPartialModeSwitch();
  } catch (error) {
    disconnectPhase = DISCONNECT_PHASE.NONE;
    throw error;
  }

  const pairingInfo = await readFlashInfo(preparedFirmware);
  if (!pairingInfo || pairingInfo.mode !== 0) {
    throw new Error('micro:bit did not enter pairing/programming mode for bonded DFU');
  }

  setState('modeState', 'pairing/programming', 'busy');
  el('progressText').textContent = 'Pairing may be requested — follow the Bluetooth and micro:bit prompts';
  log('Pairing/programming mode is active. Approve any Bluetooth connection or pairing prompt shown by the browser or device. When the micro:bit shows an arrow, press button A, then enter the displayed passkey if requested.', 'warn');

  // Let advertising, service discovery and the Bluetooth stack settle before
  // accessing the secured Buttonless DFU characteristic.
  await sleep(900);
  return pairingInfo;
}

async function prepareAndEnterFullDfu(info, reason) {
  if (!buttonlessAvailable) {
    throw new Error('The installed micro:bit application does not expose Buttonless DFU. Program a Bluetooth/DFU-enabled base firmware over USB first.');
  }

  const approved = await requestFullDfuApproval(info, preparedFirmware, reason);
  if (!approved) {
    el('progressText').textContent = 'Full application flash cancelled';
    log('Full application DFU cancelled.', 'warn');
    return;
  }

  setState('methodState', 'Full application DFU', 'warn');
  resetProgress(preparedFirmware.applicationBytes, 'Preparing full application DFU…');
  log(`Preparing application image ${formatHexAddress(preparedFirmware.applicationStart)}–${formatHexAddress(preparedFirmware.applicationEnd)} (${formatBytes(preparedFirmware.applicationBytes)}).`);
  const initPacket = await createMicrobitV2InitPacket(preparedFirmware.applicationBin);
  const hashMode = new DataView(initPacket.buffer).getUint32(20, true) === 32 ? 'SHA-256' : 'no init-packet hash';
  log(`Created micro:bit V2 DFU init packet using ${hashMode}.`);

  const preparedPackage = {
    initPacket,
    firmware: preparedFirmware.applicationBin,
    applicationStart: preparedFirmware.applicationStart,
    fileName: selectedFileName,
  };

  info = await ensurePairingModeForFullDfu(info);
  await quiescePartialNotificationsBeforeDfu();

  // Prepare the pending package before the secured write, but do not open a
  // webpage modal or a second Bluetooth chooser. Any browser or operating-system
  // Bluetooth authorization must finish first. The inline DFU button is enabled
  // when the application disconnect is observed. The user may keep the chooser open
  // while the rebooted identity is discovered.
  pendingDfu = preparedPackage;
  dfuChooserReady = false;
  buttonlessDfuCommandAttempted = false;
  unsupportedDfuCandidateIds.clear();
  applicationDeviceIdBeforeDfu = applicationDevice?.id || null;
  showDfuHandoffDialog();
  setState('connectionState', 'Authorizing DFU', 'busy');
  setState('modeState', 'Waiting for reboot', 'busy');
  el('progressText').textContent = 'Approve any Bluetooth connection prompt, then wait for the micro:bit to reboot';
  updateButtons();

  try {
    await enterButtonlessDfu(applicationDevice, {
      log,
      onCommandAttempt: () => {
        buttonlessDfuCommandAttempted = true;
        disconnectPhase = DISCONNECT_PHASE.DFU_HANDOFF;
      },
    });
  } catch (error) {
    // Some browser and operating-system Bluetooth stacks reject the secured
    // write promise while the micro:bit still accepts it and disconnects. If the disconnect has already
    // happened, continue with the prepared DFU handoff.
    if (applicationDevice?.gatt?.connected) {
      pendingDfu = null;
      dfuChooserReady = false;
      throw error;
    }
    log(`The secured write reported “${error.message}”, but the reboot disconnect was observed. Continuing to DFU selection.`, 'warn');
    markDfuChooserReady();
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
  }

  if (!applicationDevice?.gatt?.connected && buttonlessDfuCommandAttempted) markDfuChooserReady();
  log('Open the blue DFU selector and wait for the rebooted micro:bit identity to appear. Discovery may take several seconds or longer. It may retain the BBC micro:bit name; the app confirms DFU only after finding control 0001 and packet 0002.', 'warn');
  updateButtons();
}

async function program() {
  if (flashInProgress) return log('Programming already in progress; duplicate click ignored.', 'warn');
  if (!preparedFirmware) throw new Error('Choose a valid micro:bit V2 HEX first');
  if (!applicationDevice?.gatt?.connected) throw new Error('Connect the micro:bit first');

  flashInProgress = true;
  updateButtons();
  await acquireWakeLock();

  try {
    let info = null;
    if (partialCharacteristic && preparedFirmware.markerCandidates.length) {
      log('Checking runtime hashes and program layout…');
      info = await readFlashInfo(preparedFirmware);
    }

    if (info?.runtimeMatches && info.layoutMatches) {
      await runPartialFlash(info);
      return;
    }

    let reason;
    if (!partialCharacteristic) {
      reason = 'The installed application does not expose the Partial Programming Service, so the full application must be replaced.';
    } else if (!preparedFirmware.markerCandidates.length) {
      reason = 'The HEX has no usable MakeCode partial-flash marker, so it cannot be safely partial-flashed.';
    } else if (!info?.layoutMatches) {
      reason = 'The HEX program layout differs from the installed runtime. Full DFU will replace the runtime and program together.';
    } else {
      reason = 'The HEX was compiled with a different runtime. Full DFU will replace the runtime and program together.';
    }

    await prepareAndEnterFullDfu(info, reason);
  } catch (error) {
    log(error.message, 'error');
    el('progressText').textContent = `Stopped: ${error.message}`;
  } finally {
    flashInProgress = false;
    await releaseWakeLock();
    updateButtons();
    if (dfuChooserReady) {
      queueMicrotask(() => el('selectDfu')?.focus({ preventScroll: false }));
    }
  }
}

async function selectDfuAndFlash() {
  if (!pendingDfu) throw new Error('No full DFU transfer is pending');
  if (!dfuChooserReady) throw new Error('Wait for the micro:bit application to disconnect before opening the DFU selector');
  if (flashInProgress) return;

  // Keep this as the first awaited operation: requestDevice must run directly
  // from this click. Browsers do not permit the page to open it automatically
  // after a system Bluetooth prompt closes.
  const bootloaderDevice = await requestDfuDevice();
  log(`Selected DFU candidate: ${bootloaderDevice.name || '(unnamed / unknown device)'} [browser id ${bootloaderDevice.id}].`);

  if (unsupportedDfuCandidateIds.has(bootloaderDevice.id)) {
    throw new Error('This Bluetooth entry already returned “Unsupported device” during the current DFU handoff and is not GATT-connectable. Reopen the selector and choose another newly discovered entry, or cancel and enter DFU mode again to start a new handoff.');
  }

  // Do not reject a candidate by its advertised name or opaque browser ID.
  // A rebooted DFU identity can retain the BBC micro:bit name, and a browser can
  // allocate a new BluetoothDevice.id or reuse an existing permission identity.
  // The reliable test available to the page is the connected GATT table: Secure
  // DFU must expose 0001 + 0002.
  if (applicationDeviceIdBeforeDfu && bootloaderDevice.id === applicationDeviceIdBeforeDfu) {
    log('The selected entry uses the same browser identity as the application device. Continuing to GATT verification because the physical address and service table may have changed after reboot.', 'warn');
  }
  if ((bootloaderDevice.name || '').startsWith('BBC micro:bit')) {
    log('The selected DFU candidate retained the BBC micro:bit name. The name is not used for rejection; verifying Secure DFU control and packet characteristics now.', 'warn');
  }
  flashInProgress = true;
  updateButtons();
  await acquireWakeLock();

  const startedAt = performance.now();
  const packageToFlash = pendingDfu;
  resetProgress(packageToFlash.firmware.length, 'Candidate selected; attempting GATT connection…');
  setState('connectionState', 'Candidate selected', 'busy');
  setState('modeState', 'DFU not confirmed', 'busy');

  const dfu = new NordicSecureDfu({
    log,
    packetDelayMs: 2,
    progress: event => {
      if (event.type === 'init') {
        setState('connectionState', bootloaderDevice.name || 'DFU bootloader', 'good');
        setState('modeState', 'Secure DFU confirmed', 'good');
        setState('serviceState', 'Secure DFU 0001 + 0002', 'good');
        el('progressText').textContent = 'Transferring and validating DFU init packet…';
        return;
      }
      if (event.type === 'firmware') {
        const total = event.totalBytes || packageToFlash.firmware.length;
        updateProgress(
          Math.min(event.currentBytes, total),
          total,
          startedAt,
          packageToFlash.applicationStart + Math.min(event.currentBytes, total),
          'Full DFU',
        );
      }
    },
  });

  try {
    setState('methodState', 'Full application DFU', 'busy');
    log(`Starting full application DFU for ${packageToFlash.fileName}.`);
    await dfu.update(bootloaderDevice, packageToFlash.initPacket, packageToFlash.firmware);
    updateProgress(
      packageToFlash.firmware.length,
      packageToFlash.firmware.length,
      startedAt,
      packageToFlash.applicationStart + packageToFlash.firmware.length,
      'Full DFU',
      true,
    );
    el('progressPercent').textContent = '100%';
    el('progressText').textContent = 'Full application programming complete — micro:bit restarting';
    setState('methodState', 'Full DFU complete', 'good');
    setState('connectionState', 'Restarting', 'busy');
    log('Full application DFU complete. Runtime and user program were replaced; SoftDevice and bootloader were preserved.');
    pendingDfu = null;
    dfuChooserReady = false;
    applicationDeviceIdBeforeDfu = null;
    buttonlessDfuCommandAttempted = false;
    unsupportedDfuCandidateIds.clear();
    applicationDevice = null;
    partialCharacteristic = null;
    buttonlessAvailable = false;
  } catch (error) {
    if (error?.code === 'DFU_CANDIDATE_UNSUPPORTED' || /^Unsupported device\b/i.test(error?.message || '')) {
      unsupportedDfuCandidateIds.add(bootloaderDevice.id);
      log(`Marked browser id ${bootloaderDevice.id} as non-GATT-connectable for this DFU handoff. Selecting the same cached entry again will be rejected without another connection attempt.`, 'warn');
    }
    log(error.message, 'error');
    el('progressText').textContent = `DFU stopped: ${error.message}`;
    setState('methodState', 'DFU retry available', 'warn');
    log('The prepared DFU package remains available. Reopen the selector and choose another newly discovered entry. Cancel and enter DFU mode again to clear the rejected-entry list.', 'warn');
  } finally {
    flashInProgress = false;
    await releaseWakeLock();
    updateButtons();
  }
}

async function loadHexFile(file) {
  if (!file) return;
  selectedFileName = file.name;
  const selectedHex = await file.text();
  preparedFirmware = null;
  pendingDfu = null;
  dfuChooserReady = false;
  applicationDeviceIdBeforeDfu = null;
  buttonlessDfuCommandAttempted = false;
  disconnectPhase = DISCONNECT_PHASE.NONE;
  unsupportedDfuCandidateIds.clear();
  setState('fileState', 'Checking…', 'busy');
  setState('runtimeState', 'Not checked', 'neutral');
  setState('methodState', 'Not selected', 'neutral');
  el('fileName').textContent = selectedFileName;
  el('fileDetails').textContent = '';
  resetProgress(0, 'Checking HEX file…');

  try {
    preparedFirmware = prepareFirmware(selectedHex);
    const type = preparedFirmware.universal
      ? `Universal HEX → micro:bit V2 board 0x${preparedFirmware.boardId.toString(16).toUpperCase()}`
      : 'Intel HEX';
    const partial = preparedFirmware.markerCandidates.length
      ? `partial marker ${formatHexAddress(preparedFirmware.magicOffset)}`
      : 'full DFU only';
    el('fileDetails').textContent = `${type} · ${partial} · full application ${formatBytes(preparedFirmware.applicationBytes)}`;
    setState('fileState', 'Ready', 'good');
    resetProgress(preparedFirmware.applicationBytes, 'HEX ready — connect and program');
    el('status').textContent = 'HEX loaded.';
    log(`STEM Smart Labs Bluetooth Programmer v${APP_VERSION}`);
    log(`File: ${selectedFileName}`);
    log(`${type}; copied ${formatBytes(preparedFirmware.copiedBytes)} from ${preparedFirmware.dataRecords} data records.`);
    log(`Full DFU application: ${formatHexAddress(preparedFirmware.applicationStart)}–${formatHexAddress(preparedFirmware.applicationEnd)} (${formatBytes(preparedFirmware.applicationBytes)}).`);
    if (preparedFirmware.markerCandidates.length) {
      log(`Found ${preparedFirmware.markerCandidates.length} MakeCode partial-flash marker(s).`);
      log(`First marker runtime ${preparedFirmware.runtimeHash}, program ${preparedFirmware.programHash}.`);
    } else {
      log('No valid partial-flash marker found; this HEX can be programmed only by full application DFU.', 'warn');
    }
    if (!preparedFirmware.sawEof) log('Intel HEX EOF record was not found; validated records were still parsed.', 'warn');
  } catch (error) {
    preparedFirmware = null;
    setState('fileState', 'Invalid', 'bad');
    el('fileDetails').textContent = error.message;
    log(error.message, 'error');
  }
  updateButtons();
}

function cancelPendingDfu() {
  if (flashInProgress) return;
  pendingDfu = null;
  dfuChooserReady = false;
  applicationDeviceIdBeforeDfu = null;
  buttonlessDfuCommandAttempted = false;
  disconnectPhase = DISCONNECT_PHASE.NONE;
  unsupportedDfuCandidateIds.clear();
  setState('methodState', 'Cancelled', 'neutral');
  el('progressText').textContent = 'Full DFU selection cancelled';
  log('Pending full DFU transfer cancelled.', 'warn');
  updateButtons();
}

function disconnectApplication() {
  if (flashInProgress) return log('Cannot disconnect while programming is in progress.', 'warn');
  applicationDevice?.gatt?.disconnect();
  applicationDevice = null;
  partialCharacteristic = null;
  buttonlessAvailable = false;
  pendingDfu = null;
  dfuChooserReady = false;
  applicationDeviceIdBeforeDfu = null;
  buttonlessDfuCommandAttempted = false;
  disconnectPhase = DISCONNECT_PHASE.NONE;
  unsupportedDfuCandidateIds.clear();
  setState('connectionState', 'Disconnected', 'neutral');
  setState('modeState', 'Unknown', 'neutral');
  setState('serviceState', 'Not checked', 'neutral');
  setState('runtimeState', 'Not checked', 'neutral');
  setState('methodState', 'Not selected', 'neutral');
  updateButtons();
}

function setTextIfPresent(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

setTextIfPresent('appVersion', `v${APP_VERSION}`);
setTextIfPresent('buildLabel', `Build ${APP_VERSION}`);
setTextIfPresent('status', `Ready.\nSTEM Smart Labs Bluetooth Programmer v${APP_VERSION}`);
log('Matching runtime/layout uses partial flash; mismatches use full application Secure DFU.');

el('hexFile').addEventListener('change', event => loadHexFile(event.target.files?.[0]));
el('connect').addEventListener('click', () => connectApplication().catch(error => {
  setState('connectionState', 'Connection failed', 'bad');
  log(error.message, 'error');
  updateButtons();
}));
el('program').addEventListener('click', () => program().catch(error => log(error.message, 'error')));
const handleDfuSelectionClick = () => selectDfuAndFlash().catch(error => {
  log(error.message, 'error');
  el('progressText').textContent = `DFU device selection failed: ${error.message}`;
  updateButtons();
});
el('selectDfu').addEventListener('click', handleDfuSelectionClick);
el('cancelDfu').addEventListener('click', cancelPendingDfu);
el('disconnect').addEventListener('click', disconnectApplication);
el('clearLog').addEventListener('click', () => {
  el('status').textContent = `Log cleared.\nApp version: ${APP_VERSION}`;
});
el('copyLog').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('status').textContent);
    log('Diagnostic log copied to clipboard.');
  } catch (error) {
    log(`Could not copy log: ${error.message}`, 'warn');
  }
});

const dropZone = el('dropZone');
for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', event => loadHexFile(event.dataTransfer?.files?.[0]));

if (!window.isSecureContext) {
  el('status').textContent = 'Web Bluetooth requires HTTPS or localhost. GitHub Pages supplies HTTPS automatically.';
  el('connect').disabled = true;
  setState('connectionState', 'HTTPS required', 'bad');
} else if (!navigator.bluetooth) {
  el('status').textContent = 'Web Bluetooth is unavailable. Open this page in a browser and operating system that support Web Bluetooth.';
  el('connect').disabled = true;
  setState('connectionState', 'Unsupported browser', 'bad');
}

updateButtons();
