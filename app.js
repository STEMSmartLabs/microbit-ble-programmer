import {
  DEFAULT_V2_FLASH_USABLE_END,
  V2_FLASH_END,
  formatBytes,
  formatHexAddress,
  prepareHex,
  toHex,
} from './core.js';

const APP_VERSION = '1.0.0';
const SERVICE_UUID = 'e97dd91d-251d-470a-a062-fa1922dfa9a8';
const CHARACTERISTIC_UUID = 'e97d3b10-251d-470a-a062-fa1922dfa9a8';
const BLOCK_SIZE = 64;
const PACKETS_PER_BLOCK = 4;
const PACKET_DATA_SIZE = 16;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const el = id => document.getElementById(id);

let device = null;
let characteristic = null;
let preparedImage = null;
let selectedFileName = '';
let flashInProgress = false;
let expectedDisconnect = false;
let wakeLock = null;
let notificationQueue = [];
let notificationWaiters = [];
let lastProgressLogPercent = -10;

function log(message, level = 'info') {
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const prefix = level === 'error' ? 'ERROR: ' : level === 'warn' ? 'WARNING: ' : '';
  const status = el('status');
  status.textContent += `\n[${stamp}] ${prefix}${message}`;
  status.scrollTop = status.scrollHeight;
}

function setState(id, text, state = '') {
  const target = el(id);
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

function handleNotification(event) {
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

async function writePacket(bytes) {
  if (!characteristic) throw new Error('micro:bit is not connected');
  const packet = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (typeof characteristic.writeValueWithoutResponse === 'function') {
    await characteristic.writeValueWithoutResponse(packet);
  } else {
    await characteristic.writeValue(packet);
  }
}

function discardQueuedNotifications(predicate) {
  notificationQueue = notificationQueue.filter(data => !predicate(data));
}

async function command(bytes, predicate, timeoutMs = 5000) {
  discardQueuedNotifications(predicate);
  const waiter = createNotificationWaiter(predicate, timeoutMs);
  try {
    await writePacket(bytes);
    return await waiter.promise;
  } catch (error) {
    waiter.cancel(error);
    throw error;
  }
}

async function attachServices() {
  if (!device) throw new Error('No Bluetooth device selected');
  const gatt = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const service = await gatt.getPrimaryService(SERVICE_UUID);
  characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
  characteristic.removeEventListener('characteristicvaluechanged', handleNotification);
  characteristic.addEventListener('characteristicvaluechanged', handleNotification);
  await characteristic.startNotifications();
  notificationQueue = [];
}

function updateButtons() {
  const connected = Boolean(device?.gatt?.connected && characteristic);
  el('connect').disabled = flashInProgress;
  el('program').disabled = flashInProgress || !connected || !preparedImage;
  el('disconnect').disabled = flashInProgress || !connected;
  el('hexFile').disabled = flashInProgress;
}

function handleDisconnected() {
  characteristic = null;
  clearNotificationState();
  setState('connectionState', 'Disconnected', 'neutral');
  updateButtons();
  if (!expectedDisconnect) log('Disconnected.');
}

async function connect() {
  if (!window.isSecureContext) throw new Error('Web Bluetooth requires HTTPS or localhost');
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser');

  if (!device) {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [SERVICE_UUID],
    });
    device.addEventListener('gattserverdisconnected', handleDisconnected);
  }

  setState('connectionState', 'Connecting…', 'busy');
  try {
    await attachServices();
  } catch (error) {
    if (error.name === 'NotFoundError') {
      throw new Error('Programming Service not found on this micro:bit program');
    }
    throw error;
  }
  setState('connectionState', device.name || 'Connected', 'good');
  updateButtons();
  log(`Connected: ${device.name || 'BBC micro:bit'}`);
}

async function readRegion(regionId) {
  const response = await command([0x00, regionId], data => data[0] === 0x00 && data[1] === regionId, 5000);
  if (response.length < 18) throw new Error(`Invalid region ${regionId} response: ${toHex(response)}`);
  return {
    start: readU32BE(response, 2),
    end: readU32BE(response, 6),
    hash: toHex(response.slice(10, 18)),
  };
}

function validateDeviceLayout(image, makeCode) {
  if (makeCode.start !== image.magicOffset) {
    throw new Error(`HEX layout mismatch: file starts at ${formatHexAddress(image.magicOffset)}, device expects ${formatHexAddress(makeCode.start)}`);
  }
  if (makeCode.start < 0 || makeCode.start >= V2_FLASH_END
      || makeCode.end <= makeCode.start || makeCode.end > V2_FLASH_END) {
    throw new Error(`Device reported an unsafe program region ${formatHexAddress(makeCode.start)}–${formatHexAddress(makeCode.end)}`);
  }
  if (image.binary.length < makeCode.end) throw new Error('HEX image does not cover the device program region');
  if ((makeCode.start & 0x0f) !== 0) throw new Error('Device program region is not 16-byte aligned');
}

async function readFlashInfo(image) {
  const status = await command([0xee], data => data[0] === 0xee, 5000);
  if (status.length < 3) throw new Error(`Invalid partial programming status: ${toHex(status)}`);

  const version = status[1];
  const mode = status[2];
  const modeName = mode === 0 ? 'pairing/programming' : mode === 1 ? 'application' : `unknown (${mode})`;
  setState('modeState', modeName, mode <= 1 ? 'good' : 'warn');
  log(`Partial Programming Service v${version}, mode ${modeName}`);

  const dal = await readRegion(0x01);
  const makeCode = await readRegion(0x02);
  validateDeviceLayout(image, makeCode);

  const runtimeMatches = dal.hash === image.runtimeHash;
  const programMatches = makeCode.hash === image.programHash;
  setState('runtimeState', runtimeMatches ? 'Runtime match' : 'Runtime mismatch', runtimeMatches ? 'good' : 'warn');

  log(`HEX runtime hash:       ${image.runtimeHash}`);
  log(`Device runtime hash:    ${dal.hash}`);
  log(`HEX program hash:       ${image.programHash}`);
  log(`Device program hash:    ${makeCode.hash}`);
  log(`Program region:         ${formatHexAddress(makeCode.start)}–${formatHexAddress(makeCode.end)} (${formatBytes(makeCode.end - makeCode.start)})`);

  return { version, mode, dal, makeCode, runtimeMatches, programMatches };
}

function requestRuntimeMismatchApproval(info, image) {
  const dialog = el('runtimeWarningDialog');
  el('warningHexHash').textContent = image.runtimeHash;
  el('warningDeviceHash').textContent = info.dal.hash;
  el('forceAcknowledge').checked = false;
  el('confirmForce').disabled = true;

  return new Promise(resolve => {
    const finish = approved => {
      dialog.close();
      cleanup();
      resolve(approved);
    };
    const onCheck = () => { el('confirmForce').disabled = !el('forceAcknowledge').checked; };
    const onCancel = event => { event.preventDefault(); finish(false); };
    const onCancelClick = () => finish(false);
    const onConfirm = () => finish(true);
    const cleanup = () => {
      el('forceAcknowledge').removeEventListener('change', onCheck);
      el('cancelForce').removeEventListener('click', onCancelClick);
      el('confirmForce').removeEventListener('click', onConfirm);
      dialog.removeEventListener('cancel', onCancel);
    };

    el('forceAcknowledge').addEventListener('change', onCheck);
    el('cancelForce').addEventListener('click', onCancelClick);
    el('confirmForce').addEventListener('click', onConfirm);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
  });
}

async function reconnectAfterModeSwitch() {
  expectedDisconnect = true;
  try {
    if (device?.gatt?.connected) device.gatt.disconnect();
    characteristic = null;
    clearNotificationState(new Error('Switching micro:bit mode'));

    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        await sleep(attempt === 1 ? 900 : 500);
        await attachServices();
        setState('connectionState', device.name || 'Connected', 'good');
        log(`Reconnected in Programming mode (attempt ${attempt}).`);
        return;
      } catch (error) {
        if (attempt === 20) throw new Error(`Could not reconnect in programming mode: ${error.message}`);
      }
    }
  } finally {
    expectedDisconnect = false;
  }
}

function makeDataPacket(image, offset, packetNumber, part) {
  const packet = new Uint8Array(20);
  packet[0] = 0x01;
  packet[3] = (packetNumber + part) & 0xff;

  if (part === 0) {
    packet[1] = (offset >>> 8) & 0xff;
    packet[2] = offset & 0xff;
  } else if (part === 1) {
    packet[1] = (offset >>> 24) & 0xff;
    packet[2] = (offset >>> 16) & 0xff;
  }

  const sourceStart = offset + part * PACKET_DATA_SIZE;
  packet.set(image.binary.slice(sourceStart, sourceStart + PACKET_DATA_SIZE), 4);
  return packet;
}

async function sendBlock(image, offset, packetNumber, chunkDelay) {
  discardQueuedNotifications(data => data[0] === 0x01);
  const waiter = createNotificationWaiter(data => data[0] === 0x01, 7000);
  const ackPromise = waiter.promise;

  try {
    for (let part = 0; part < PACKETS_PER_BLOCK; part++) {
      if (chunkDelay) await sleep(chunkDelay);
      await writePacket(makeDataPacket(image, offset, packetNumber, part));
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
      await writePacket(bogus);
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

function updateProgress(doneBytes, totalBytes, startTime, address, forceLog = false) {
  const percent = totalBytes ? Math.min(100, (doneBytes / totalBytes) * 100) : 0;
  const elapsedSeconds = (performance.now() - startTime) / 1000;
  const bytesPerSecond = elapsedSeconds > 0 ? doneBytes / elapsedSeconds : 0;
  const etaSeconds = bytesPerSecond > 0 ? (totalBytes - doneBytes) / bytesPerSecond : Infinity;

  el('progress').max = Math.max(1, totalBytes);
  el('progress').value = Math.min(doneBytes, totalBytes);
  el('progressPercent').textContent = `${Math.floor(percent)}%`;
  el('progressText').textContent = `Writing ${formatHexAddress(address)}`;
  el('bytesText').textContent = `${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}`;
  el('timeText').textContent = `Elapsed ${formatDuration(elapsedSeconds)} · ETA ${formatDuration(etaSeconds)}`;

  const wholePercent = Math.floor(percent);
  if (forceLog || wholePercent >= lastProgressLogPercent + 10) {
    lastProgressLogPercent = Math.floor(wholePercent / 10) * 10;
    log(`Progress ${wholePercent}% — ${formatBytes(doneBytes)} of ${formatBytes(totalBytes)} — ${formatHexAddress(address)}`);
  }
}

async function transfer(image, transferEnd) {
  let offset = image.magicOffset;
  let packetNumber = 0;
  let chunkDelay = 15;
  let retriesForBlock = 0;
  const totalBytes = transferEnd - image.magicOffset;
  const startedAt = performance.now();

  resetProgress(totalBytes, 'Starting Bluetooth transfer…');
  updateProgress(0, totalBytes, startedAt, offset, true);

  while (offset < transferEnd) {
    const ack = await sendBlock(image, offset, packetNumber, chunkDelay);
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

    offset += BLOCK_SIZE;
    packetNumber = (packetNumber + 4) & 0xff;
    retriesForBlock = 0;
    chunkDelay = Math.max(0, chunkDelay - 1);
    updateProgress(offset - image.magicOffset, totalBytes, startedAt, Math.min(offset, transferEnd));
  }

  updateProgress(totalBytes, totalBytes, startedAt, transferEnd, true);
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

async function program() {
  if (flashInProgress) return log('Programming already in progress; duplicate click ignored.', 'warn');
  if (!preparedImage) throw new Error('Choose a compatible MakeCode HEX first');
  if (!device?.gatt?.connected || !characteristic) throw new Error('Connect the micro:bit first');

  flashInProgress = true;
  updateButtons();
  await acquireWakeLock();
  let runtimeOverrideApproved = false;

  try {
    log('Checking runtime hashes and the device program region…');
    let info = await readFlashInfo(preparedImage);

    if (!info.runtimeMatches) {
      const approved = await requestRuntimeMismatchApproval(info, preparedImage);
      if (!approved) {
        el('progressText').textContent = 'Programming cancelled at runtime warning';
        log('Program cancelled because the installed runtime does not match the HEX.', 'warn');
        return;
      }
      runtimeOverrideApproved = true;
      setState('runtimeState', 'Mismatch — force approved', 'warn');
      log('Experimental force mode approved. The installed runtime will not be changed.', 'warn');
    }

    if (info.mode === 1 && info.programMatches) {
      await writePacket([0xff, 0x01]);
      el('progress').max = 100;
      el('progress').value = 100;
      el('progressPercent').textContent = '100%';
      el('progressText').textContent = 'The selected program is already installed';
      log(runtimeOverrideApproved
        ? 'Program bytes already match. Restarted without rewriting; the runtime mismatch remains.'
        : 'Program already installed; micro:bit restarted in application mode.');
      return;
    }

    if (info.mode === 0 && info.programMatches) {
      log('Program hash matches, but the micro:bit is in programmming mode. Rewriting to recover from a possible interrupted programming.', 'warn');
    }

    if (info.mode !== 0) {
      expectedDisconnect = true;
      await writePacket([0xff, 0x00]);
      log('Switching micro:bit to pairing/programming mode…');
      await reconnectAfterModeSwitch();
      info = await readFlashInfo(preparedImage);
      if (info.mode !== 0) throw new Error('micro:bit did not enter pairing/programming mode');
      if (!info.runtimeMatches && !runtimeOverrideApproved) throw new Error('Runtime changed during reconnect; force approval is required');
    }

    const transferEnd = info.makeCode.end;
    const transferBytes = transferEnd - preparedImage.magicOffset;
    log(`Starting transfer of ${formatBytes(transferBytes)} from ${formatHexAddress(preparedImage.magicOffset)} to ${formatHexAddress(transferEnd)}.`);
    if (!info.runtimeMatches) log('FORCED RUNTIME MISMATCH: this transfer is experimental.', 'warn');
    await transfer(preparedImage, transferEnd);

    log('Sending end-of-transmission command…');
    await writePacket([0x02]);
    el('progress').value = el('progress').max;
    el('progressPercent').textContent = '100%';
    el('progressText').textContent = 'Programming complete — micro:bit restarting';
    log('Programming complete. The micro:bit is restarting into the new program.');
  } catch (error) {
    log(error.message, 'error');
    el('progressText').textContent = `Stopped: ${error.message}`;
  } finally {
    expectedDisconnect = false;
    flashInProgress = false;
    await releaseWakeLock();
    updateButtons();
  }
}

async function loadHexFile(file) {
  if (!file) return;
  selectedFileName = file.name;
  const selectedHex = await file.text();
  preparedImage = null;
  setState('fileState', 'Checking…', 'busy');
  setState('runtimeState', 'Not checked', 'neutral');
  el('fileName').textContent = selectedFileName;
  el('fileDetails').textContent = '';
  resetProgress(0, 'Checking HEX file…');

  try {
    preparedImage = prepareHex(selectedHex);
    const type = preparedImage.universal ? 'Universal HEX → micro:bit V2' : 'Intel HEX';
    const estimate = preparedImage.magicOffset < DEFAULT_V2_FLASH_USABLE_END
      ? DEFAULT_V2_FLASH_USABLE_END - preparedImage.magicOffset
      : 0;
    el('fileDetails').textContent = `${type} · program start ${formatHexAddress(preparedImage.magicOffset)} · estimated transfer ${formatBytes(estimate)}`;
    setState('fileState', 'Ready', 'good');
    resetProgress(estimate, 'HEX ready — connect and program');
    el('status').textContent = 'HEX loaded.';
    log(`STEM Smart Labs Bluetooth Programmer v${APP_VERSION}`);
    log(`File: ${selectedFileName}`);
    log(`${type}; copied ${formatBytes(preparedImage.copiedBytes)} from ${preparedImage.dataRecords} data records.`);
    log(`Ignored ${preparedImage.ignoredHighRecords} record(s) outside micro:bit V2 physical programming.`);
    if (!preparedImage.sawEof) log('Intel HEX EOF record was not found; validated records were still parsed.', 'warn');
    log(`Program start ${formatHexAddress(preparedImage.magicOffset)}; final transfer end will come from the connected micro:bit.`);
  } catch (error) {
    preparedImage = null;
    setState('fileState', 'Invalid', 'bad');
    el('fileDetails').textContent = error.message;
    log(error.message, 'error');
  }
  updateButtons();
}

function setTextIfPresent(id, text) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = text;
  }
}

setTextIfPresent('appVersion', `v${APP_VERSION}`);
setTextIfPresent('buildLabel', `Build ${APP_VERSION}`);
setTextIfPresent(
  'status',
  `Ready.\nSTEM Smart Labs Bluetooth Programmer v${APP_VERSION}`
);

log('Runtime mismatch override is available as an explicit experimental confirmation.');

el('hexFile').addEventListener('change', event => loadHexFile(event.target.files?.[0]));
el('connect').addEventListener('click', () => connect().catch(error => {
  setState('connectionState', 'Connection failed', 'bad');
  log(error.message, 'error');
  updateButtons();
}));
el('program').addEventListener('click', () => program().catch(error => log(error.message, 'error')));
el('disconnect').addEventListener('click', () => {
  if (flashInProgress) return log('Cannot disconnect while programming is in progress.', 'warn');
  device?.gatt?.disconnect();
  characteristic = null;
  setState('connectionState', 'Disconnected', 'neutral');
  setState('modeState', 'Unknown', 'neutral');
  setState('runtimeState', 'Not checked', 'neutral');
  updateButtons();
});
el('clearLog').addEventListener('click', () => { el('status').textContent = `Log cleared.\nApp version: ${APP_VERSION}`; });
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
  el('status').textContent = 'Web Bluetooth is unavailable. Open this page in a browser that supports Web Bluetooth.';
  el('connect').disabled = true;
  setState('connectionState', 'Unsupported browser', 'bad');
}

updateButtons();
