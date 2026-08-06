import {
  V2_FLASH_END,
  formatBytes,
  prepareFirmware,
  selectMarkerCandidate,
  toHex,
} from './core.js';
import { classifyBluetoothCompatibility } from './compatibility.js?v=2.6.0';

const APP_VERSION = '2.6.0';
const PARTIAL_SERVICE_UUID = 'e97dd91d-251d-470a-a062-fa1922dfa9a8';
const PARTIAL_CHARACTERISTIC_UUID = 'e97d3b10-251d-470a-a062-fa1922dfa9a8';
const PARTIAL_BLOCK_SIZE = 64;
const PARTIAL_PACKETS_PER_BLOCK = 4;
const PARTIAL_PACKET_DATA_SIZE = 16;
const REMEMBERED_DEVICE_KEY = 'stem.microbit.bluetoothDeviceId';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const el = id => document.getElementById(id);

let microbit = null;
let characteristic = null;
let preparedFirmware = null;
let selectedFileName = '';
let currentInfo = null;
let busy = false;
let reconnecting = false;
let expectedRestart = false;
let wakeLock = null;
let notificationQueue = [];
let notificationWaiters = [];
let lastProgressLogPercent = -10;

function log(message, level = 'info') {
  const stamp = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const prefix = level === 'error' ? 'ERROR: ' : level === 'warn' ? 'NOTICE: ' : '';
  const status = el('status');
  status.textContent += `\n[${stamp}] ${prefix}${message}`;
  status.scrollTop = status.scrollHeight;
}

function setState(id, text, state = 'neutral') {
  const target = el(id);
  if (!target) return;
  target.textContent = text;
  target.dataset.state = state;
}

function setProgressMessage(text) {
  el('progressText').textContent = text;
}

function setUsbRecommended(message = 'This program cannot be sent by Bluetooth. Use USB instead.') {
  currentInfo = null;
  setState('programState', 'Use USB', 'warn');
  setProgressMessage(message);
  el('timeText').textContent = 'USB recommended';
  updateButtons();
}

function readU32BE(bytes, offset) {
  if (bytes.length < offset + 4) throw new Error('The micro:bit response was incomplete');
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

function clearNotificationState(error = new Error('Bluetooth connection closed')) {
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
      waiter.reject(new Error('The micro:bit did not respond in time'));
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
  if (!characteristic) throw new Error('The micro:bit is not ready');
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

async function sendCommand(bytes, predicate, timeoutMs = 5000) {
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

async function attachProgrammingService() {
  if (!microbit) throw new Error('No micro:bit selected');
  const server = microbit.gatt.connected ? microbit.gatt : await microbit.gatt.connect();

  characteristic = null;
  clearNotificationState(new Error('Refreshing connection'));

  try {
    const service = await server.getPrimaryService(PARTIAL_SERVICE_UUID);
    characteristic = await service.getCharacteristic(PARTIAL_CHARACTERISTIC_UUID);
    characteristic.removeEventListener('characteristicvaluechanged', handleNotification);
    characteristic.addEventListener('characteristicvaluechanged', handleNotification);
    await characteristic.startNotifications();
  } catch (error) {
    characteristic = null;
    throw new Error('Bluetooth programming is not available on this micro:bit');
  }
}

function rememberDevice(device) {
  try { localStorage.setItem(REMEMBERED_DEVICE_KEY, device.id); } catch {}
}

function forgetRememberedDeviceId() {
  try { localStorage.removeItem(REMEMBERED_DEVICE_KEY); } catch {}
}

async function getRememberedDevice() {
  if (typeof navigator.bluetooth?.getDevices !== 'function') return null;
  const devices = await navigator.bluetooth.getDevices();
  let savedId = null;
  try { savedId = localStorage.getItem(REMEMBERED_DEVICE_KEY); } catch {}

  if (savedId) {
    const saved = devices.find(device => device.id === savedId);
    if (saved) return saved;
  }

  return devices.find(device => (device.name || '').startsWith('BBC micro:bit')) || null;
}

async function chooseDevice() {
  const remembered = await getRememberedDevice();
  if (remembered) return { device: remembered, reused: true };

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'BBC micro:bit' }],
    optionalServices: [PARTIAL_SERVICE_UUID],
  });
  return { device, reused: false };
}

function handleDisconnected() {
  characteristic = null;
  clearNotificationState();

  if (reconnecting) {
    setState('connectionState', 'Reconnecting…', 'busy');
    log('The micro:bit is restarting for programming.');
  } else if (expectedRestart) {
    expectedRestart = false;
    setState('connectionState', 'Restarting', 'busy');
    setState('programState', 'Complete', 'good');
    setProgressMessage('Programming complete. The micro:bit is restarting.');
    log('Programming completed successfully.');
  } else {
    setState('connectionState', 'Not connected', 'neutral');
    setState('programState', preparedFirmware ? 'Connect to check' : 'Waiting', 'neutral');
    setProgressMessage(preparedFirmware
      ? 'Connect the micro:bit to check this file.'
      : 'Choose a file and connect your micro:bit.');
    log('Disconnected.');
  }

  currentInfo = null;
  updateButtons();
}

function updateButtons() {
  const connected = Boolean(microbit?.gatt?.connected && characteristic);
  el('connect').disabled = busy || connected;
  el('program').disabled = busy || !connected || !currentInfo?.supported;
  el('disconnect').disabled = busy || !microbit?.gatt?.connected;
  el('hexFile').disabled = busy;
}

function validateDeviceProgramRegion(region) {
  if (region.start < 0 || region.start >= V2_FLASH_END
      || region.end <= region.start || region.end > V2_FLASH_END
      || (region.start & 0x0f) !== 0) {
    throw new Error('The micro:bit reported an unsupported program area');
  }
}

async function readRegion(regionId) {
  const response = await sendCommand(
    [0x00, regionId],
    data => data[0] === 0x00 && data[1] === regionId,
    5000,
  );
  if (response.length < 18) throw new Error('The micro:bit response was incomplete');
  return {
    start: readU32BE(response, 2),
    end: readU32BE(response, 6),
    hash: toHex(response.slice(10, 18)),
  };
}

async function readProgrammingInfo() {
  if (!characteristic || !preparedFirmware) return null;
  const status = await sendCommand([0xee], data => data[0] === 0xee, 5000);
  if (status.length < 3) throw new Error('The micro:bit response was incomplete');

  const mode = status[2];
  const deviceRuntime = await readRegion(0x01);
  const deviceProgram = await readRegion(0x02);
  validateDeviceProgramRegion(deviceProgram);

  const result = classifyBluetoothCompatibility({
    markerCandidates: preparedFirmware.markerCandidates,
    deviceRuntimeHash: deviceRuntime.hash,
    deviceProgramStart: deviceProgram.start,
  });

  if (!result.supported) {
    return {
      supported: false,
      reason: result.reason,
      mode,
      deviceProgram,
    };
  }

  const image = selectMarkerCandidate(preparedFirmware, result.candidate);
  return {
    supported: true,
    reason: 'ready',
    mode,
    deviceProgram,
    image,
    programMatches: result.candidate.programHash === deviceProgram.hash,
  };
}

async function checkCompatibility() {
  currentInfo = null;

  if (!preparedFirmware) {
    setState('programState', 'Choose a file', 'neutral');
    updateButtons();
    return;
  }

  if (!preparedFirmware.markerCandidates.length) {
    setUsbRecommended();
    log('This file requires USB programming.', 'warn');
    return;
  }

  if (!microbit?.gatt?.connected || !characteristic) {
    setState('programState', 'Connect to check', 'neutral');
    setProgressMessage('Connect the micro:bit to check this file.');
    updateButtons();
    return;
  }

  setState('programState', 'Checking…', 'busy');
  setProgressMessage('Checking whether this file can be sent by Bluetooth…');

  try {
    const info = await readProgrammingInfo();
    if (!info?.supported) {
      setUsbRecommended();
      log('This file does not match the software on the micro:bit. Use USB.', 'warn');
      return;
    }

    currentInfo = info;
    setState('programState', info.programMatches ? 'Already installed' : 'Ready', 'good');
    setProgressMessage(info.programMatches
      ? 'This program is already on the micro:bit. Select Program to restart it.'
      : 'Bluetooth programming is available. Select Program.');
    el('timeText').textContent = 'Bluetooth available';
    log('The file is ready for Bluetooth programming.');
  } catch (error) {
    console.error(error);
    setUsbRecommended('Bluetooth programming could not be confirmed. Use USB instead.');
    log('Bluetooth programming could not be confirmed. Use USB.', 'warn');
  }

  updateButtons();
}

async function connect() {
  if (!window.isSecureContext) {
    setState('connectionState', 'HTTPS required', 'bad');
    setProgressMessage('Open this page using HTTPS.');
    return;
  }
  if (!navigator.bluetooth) {
    setState('connectionState', 'Not supported', 'bad');
    setProgressMessage('Bluetooth programming is not supported in this browser. Use USB.');
    return;
  }

  busy = true;
  currentInfo = null;
  setState('connectionState', 'Connecting…', 'busy');
  setState('programState', 'Waiting', 'neutral');
  setProgressMessage('Connecting to your micro:bit…');
  updateButtons();

  let reused = false;
  try {
    if (!microbit) {
      const selected = await chooseDevice();
      microbit = selected.device;
      reused = selected.reused;
      microbit.removeEventListener('gattserverdisconnected', handleDisconnected);
      microbit.addEventListener('gattserverdisconnected', handleDisconnected);
    }

    await attachProgrammingService();
    rememberDevice(microbit);
    setState('connectionState', microbit.name || 'Connected', 'good');
    log(reused ? 'Reconnected to the saved micro:bit.' : 'Connected to the micro:bit.');
    await checkCompatibility();
  } catch (error) {
    console.error(error);
    characteristic = null;
    currentInfo = null;

    const cancelled = /cancel|chooser/i.test(error?.message || '');
    if (cancelled) {
      setState('connectionState', 'Not connected', 'neutral');
      setProgressMessage('No micro:bit was selected.');
      log('No micro:bit was selected.');
    } else if (reused) {
      forgetRememberedDeviceId();
      microbit = null;
      setState('connectionState', 'Try again', 'warn');
      setProgressMessage('The saved connection could not be used. Select Connect again and choose your micro:bit.');
      log('The saved connection could not be used. Select Connect again.');
    } else {
      setState('connectionState', 'Not available', 'warn');
      setUsbRecommended('Bluetooth programming is not available on this micro:bit. Use USB instead.');
      log('Bluetooth programming is not available on this micro:bit. Use USB.', 'warn');
    }
  } finally {
    busy = false;
    updateButtons();
  }
}

async function reconnectForProgramming() {
  reconnecting = true;
  characteristic = null;
  clearNotificationState(new Error('Restarting for programming'));

  if (microbit?.gatt?.connected) {
    try { microbit.gatt.disconnect(); } catch {}
  }

  let lastError = null;
  try {
    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        await sleep(attempt === 1 ? 900 : 500);
        await attachProgrammingService();
        setState('connectionState', microbit.name || 'Connected', 'good');
        log('Reconnected and ready to program.');
        return;
      } catch (error) {
        lastError = error;
      }
    }
  } finally {
    reconnecting = false;
  }

  throw new Error(lastError?.message || 'Could not reconnect to the micro:bit');
}

function makeDataPacket(image, offset, packetNumber, part) {
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

async function sendBlock(image, offset, packetNumber, packetDelayMs) {
  discardQueuedNotifications(data => data[0] === 0x01);
  const waiter = createNotificationWaiter(data => data[0] === 0x01, 7000);
  const acknowledgement = waiter.promise;

  try {
    for (let part = 0; part < PARTIAL_PACKETS_PER_BLOCK; part++) {
      if (packetDelayMs) await sleep(packetDelayMs);
      await writePacket(makeDataPacket(image, offset, packetNumber, part));
    }

    for (let probe = 0; probe < 8; probe++) {
      const race = await Promise.race([
        acknowledgement.then(value => ({ value })),
        sleep(650).then(() => ({ timeout: true })),
      ]);
      if (!race.timeout) return race.value;
      if (waiter.isSettled()) return await acknowledgement;
      const probePacket = new Uint8Array(20);
      probePacket[0] = 0x01;
      probePacket[3] = 0xff;
      await writePacket(probePacket);
    }

    return await acknowledgement;
  } catch (error) {
    waiter.cancel(error);
    throw error;
  }
}

function resetProgress(totalBytes = 0, text = 'Ready') {
  el('progress').max = Math.max(1, totalBytes);
  el('progress').value = 0;
  el('progressPercent').textContent = '0%';
  el('progressText').textContent = text;
  el('bytesText').textContent = `0 B / ${formatBytes(totalBytes)}`;
  el('timeText').textContent = 'Ready';
  lastProgressLogPercent = -10;
}

function updateProgress(doneBytes, totalBytes, startedAt, forceLog = false) {
  const percent = totalBytes ? Math.min(100, (doneBytes / totalBytes) * 100) : 0;
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const bytesPerSecond = elapsedSeconds > 0 ? doneBytes / elapsedSeconds : 0;
  const etaSeconds = bytesPerSecond > 0 ? (totalBytes - doneBytes) / bytesPerSecond : Infinity;

  el('progress').max = Math.max(1, totalBytes);
  el('progress').value = Math.min(doneBytes, totalBytes);
  el('progressPercent').textContent = `${Math.floor(percent)}%`;
  el('progressText').textContent = 'Sending program…';
  el('bytesText').textContent = `${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}`;
  el('timeText').textContent = `Elapsed ${formatDuration(elapsedSeconds)} · Remaining ${formatDuration(etaSeconds)}`;

  const wholePercent = Math.floor(percent);
  if (forceLog || wholePercent >= lastProgressLogPercent + 10) {
    lastProgressLogPercent = Math.floor(wholePercent / 10) * 10;
    log(`Programming ${wholePercent}% complete.`);
  }
}

async function transferProgram(image, transferEnd) {
  let offset = image.magicOffset;
  let packetNumber = 0;
  let packetDelayMs = 15;
  let retriesForBlock = 0;
  const totalBytes = transferEnd - image.magicOffset;
  const startedAt = performance.now();

  resetProgress(totalBytes, 'Starting programming…');
  updateProgress(0, totalBytes, startedAt, true);

  while (offset < transferEnd) {
    const acknowledgement = await sendBlock(image, offset, packetNumber, packetDelayMs);
    if (acknowledgement.length < 2) throw new Error('The micro:bit response was incomplete');

    if (acknowledgement[1] === 0xaa) {
      retriesForBlock++;
      if (retriesForBlock > 12) throw new Error('The Bluetooth transfer could not continue');
      packetNumber = (packetNumber + 4) & 0xff;
      packetDelayMs = Math.min(packetDelayMs + 10, 75);
      continue;
    }

    if (acknowledgement[1] !== 0xff) throw new Error('The micro:bit did not accept the program data');

    offset += PARTIAL_BLOCK_SIZE;
    packetNumber = (packetNumber + 4) & 0xff;
    retriesForBlock = 0;
    packetDelayMs = Math.max(0, packetDelayMs - 1);
    updateProgress(offset - image.magicOffset, totalBytes, startedAt);
  }

  updateProgress(totalBytes, totalBytes, startedAt, true);
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}

function showComplete(totalBytes) {
  el('progress').max = Math.max(1, totalBytes || 100);
  el('progress').value = totalBytes || 100;
  el('progressPercent').textContent = '100%';
  el('progressText').textContent = 'Programming complete. The micro:bit is restarting.';
  el('bytesText').textContent = totalBytes ? `${formatBytes(totalBytes)} / ${formatBytes(totalBytes)}` : 'Complete';
  el('timeText').textContent = 'Complete';
  setState('programState', 'Complete', 'good');
}

async function program() {
  if (busy) return;
  if (!preparedFirmware || !currentInfo?.supported) {
    setUsbRecommended();
    return;
  }
  if (!microbit?.gatt?.connected || !characteristic) {
    setState('connectionState', 'Not connected', 'warn');
    setProgressMessage('Connect your micro:bit before programming.');
    return;
  }

  busy = true;
  expectedRestart = false;
  setState('programState', 'Programming…', 'busy');
  setProgressMessage('Preparing to send the program…');
  updateButtons();
  await acquireWakeLock();

  try {
    let info = currentInfo;

    if (info.mode === 1 && info.programMatches) {
      expectedRestart = true;
      await writePacket([0xff, 0x01]);
      showComplete(0);
      log('The program was already installed and the micro:bit was restarted.');
      return;
    }

    if (info.mode !== 0) {
      reconnecting = true;
      await writePacket([0xff, 0x00]);
      await reconnectForProgramming();
      info = await readProgrammingInfo();

      if (!info?.supported || info.mode !== 0) {
        setUsbRecommended();
        throw new Error('The program cannot be sent by Bluetooth');
      }
      currentInfo = info;
    }

    const transferEnd = info.deviceProgram.end;
    const totalBytes = transferEnd - info.image.magicOffset;
    await transferProgram(info.image, transferEnd);

    expectedRestart = true;
    await writePacket([0x02]);
    showComplete(totalBytes);
    log('Programming completed successfully.');
    currentInfo = null;
  } catch (error) {
    console.error(error);
    expectedRestart = false;
    setState('programState', 'Try again', 'warn');
    setProgressMessage('Programming stopped. Reconnect the micro:bit and try again.');
    el('timeText').textContent = 'Stopped';
    log('Programming stopped. Reconnect the micro:bit and try again.', 'error');
  } finally {
    busy = false;
    await releaseWakeLock();
    updateButtons();
  }
}

async function loadHexFile(file) {
  if (!file) return;

  selectedFileName = file.name;
  preparedFirmware = null;
  currentInfo = null;
  setState('fileState', 'Checking…', 'busy');
  setState('programState', 'Waiting', 'neutral');
  el('fileName').textContent = selectedFileName;
  el('fileDetails').textContent = 'Checking file…';
  resetProgress(0, 'Checking the selected file…');

  try {
    const text = await file.text();
    preparedFirmware = prepareFirmware(text);

    if (!preparedFirmware.markerCandidates.length) {
      setState('fileState', 'Use USB', 'warn');
      el('fileDetails').textContent = 'This file is not suitable for Bluetooth programming.';
      setUsbRecommended();
      log('The selected file requires USB programming.', 'warn');
    } else {
      setState('fileState', 'Ready', 'good');
      el('fileDetails').textContent = `MakeCode file ready · ${formatBytes(file.size)}`;
      resetProgress(preparedFirmware.estimatedTransferBytes, 'File ready. Connect your micro:bit.');
      log(`File selected: ${selectedFileName}`);
      await checkCompatibility();
    }
  } catch (error) {
    console.error(error);
    preparedFirmware = null;
    setState('fileState', 'Not valid', 'bad');
    setState('programState', 'Waiting', 'neutral');
    el('fileDetails').textContent = 'Choose a valid micro:bit V2 MakeCode .hex file.';
    resetProgress(0, 'The selected file could not be used.');
    log('The selected file could not be used.', 'error');
  }

  updateButtons();
}

function disconnect() {
  if (busy) return;

  if (microbit) {
    microbit.removeEventListener('gattserverdisconnected', handleDisconnected);
    try { microbit.gatt?.disconnect(); } catch {}
  }

  microbit = null;
  characteristic = null;
  currentInfo = null;
  expectedRestart = false;
  reconnecting = false;
  clearNotificationState();
  setState('connectionState', 'Not connected', 'neutral');
  setState('programState', preparedFirmware ? 'Connect to check' : 'Waiting', 'neutral');
  setProgressMessage(preparedFirmware
    ? 'Connect the micro:bit to check this file.'
    : 'Choose a file and connect your micro:bit.');
  log('Disconnected.');
  updateButtons();
}

function setTextIfPresent(id, text) {
  const target = document.getElementById(id);
  if (target) target.textContent = text;
}

setTextIfPresent('appVersion', `v${APP_VERSION}`);
setTextIfPresent('buildLabel', `Build ${APP_VERSION}`);
setTextIfPresent('status', `Ready.\nSTEM Smart Labs Bluetooth Programmer v${APP_VERSION}`);

el('hexFile').addEventListener('change', event => loadHexFile(event.target.files?.[0]));
el('connect').addEventListener('click', connect);
el('program').addEventListener('click', program);
el('disconnect').addEventListener('click', disconnect);
el('clearLog').addEventListener('click', () => {
  el('status').textContent = `Ready.\nApp version ${APP_VERSION}`;
});
el('copyLog').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('status').textContent);
    log('Activity details copied.');
  } catch {
    log('Activity details could not be copied.', 'warn');
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
  setState('connectionState', 'HTTPS required', 'bad');
  setProgressMessage('Open this page using HTTPS.');
  el('connect').disabled = true;
} else if (!navigator.bluetooth) {
  setState('connectionState', 'Not supported', 'bad');
  setProgressMessage('Bluetooth programming is not supported in this browser. Use USB.');
  el('connect').disabled = true;
}

updateButtons();
