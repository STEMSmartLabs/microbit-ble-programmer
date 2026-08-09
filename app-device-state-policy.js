import { patchAppSourceForRuntimeIndependentDfu } from './app-dfu-entry-policy.js?v=2.4.10';

const DEFAULT_VERSION = '2.4.10';

function replaceFunction(source, functionStart, nextFunctionStart, replacement, label) {
  const start = source.indexOf(functionStart);
  const end = source.indexOf(nextFunctionStart, start);
  if (start < 0 || end < 0) {
    throw new Error(`Could not patch ${label}: expected function boundary was not found`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function liveGattAttachFunction() {
  return `async function attachApplicationServices() {
  if (!applicationDevice) throw new Error('No Bluetooth device selected');
  const server = applicationDevice.gatt.connected
    ? applicationDevice.gatt
    : await applicationDevice.gatt.connect();

  partialCharacteristic = null;
  buttonlessAvailable = false;
  secureDfuAvailable = false;
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
  const secureCharacteristicsAvailable = Boolean(dfu?.control && dfu?.packet);
  const applicationServicesAvailable = Boolean(partialCharacteristic || buttonlessAvailable);

  // Classification is based on the live connected GATT table, never on the
  // cached Bluetooth name. If Chrome exposes an ambiguous cached table with
  // both application and bootloader characteristics, fail safe as application
  // mode rather than starting a direct recovery flash.
  secureDfuAvailable = secureCharacteristicsAvailable && !applicationServicesAvailable;
  if (secureCharacteristicsAvailable && applicationServicesAvailable) {
    log('The connected Bluetooth identity exposes both application and Secure DFU characteristics. Treating it as application mode until the service table becomes unambiguous.', 'warn');
  }

  if (!applicationServicesAvailable && !secureDfuAvailable) {
    throw new Error('The selected Bluetooth device is not a compatible micro:bit application or Secure DFU bootloader');
  }

  if (secureDfuAvailable) {
    setState('serviceState', 'Secure DFU 0001 + 0002', 'good');
    return { mode: 'secure-dfu', server, dfu };
  }

  if (partialCharacteristic && buttonlessAvailable) {
    setState('serviceState', 'Partial + Full DFU', 'good');
  } else if (partialCharacteristic) {
    setState('serviceState', 'Partial only', 'warn');
  } else {
    setState('serviceState', 'Full DFU only', 'good');
  }
  return { mode: 'application', server, dfu };
}
`;
}

function liveGattButtonsFunction() {
  return `function updateButtons() {
  const connected = Boolean(
    applicationDevice?.gatt?.connected
    && (partialCharacteristic || buttonlessAvailable || secureDfuAvailable)
  );
  el('connect').disabled = flashInProgress;
  el('program').disabled = flashInProgress || Boolean(pendingDfu) || !connected || !preparedFirmware;
  el('disconnect').disabled = flashInProgress || !applicationDevice?.gatt?.connected;
  el('hexFile').disabled = flashInProgress;
  el('selectDfu').hidden = !pendingDfu;
  el('selectDfu').disabled = flashInProgress || !pendingDfu || !dfuChooserReady;
  el('cancelDfu').hidden = !pendingDfu;
  el('cancelDfu').disabled = flashInProgress || !pendingDfu;
}
`;
}

function liveGattConnectFunction() {
  return `async function connectApplication() {
  if (!window.isSecureContext) throw new Error('Web Bluetooth requires HTTPS or localhost');
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser');

  if (!applicationDevice) {
    applicationDevice = await navigator.bluetooth.requestDevice({
      // Chrome/macOS may temporarily retain the name DfuTarg after a failed
      // update even when the application is already running again. Permit both
      // advertised names. The FE59 filter also permits an unnamed Secure DFU
      // bootloader when the browser exposes its advertised service UUID.
      filters: [
        { namePrefix: 'BBC micro:bit' },
        { namePrefix: 'DfuTarg' },
        { services: [DFU_SERVICE_UUID] },
      ],
      optionalServices: [PARTIAL_SERVICE_UUID, DFU_SERVICE_UUID],
    });
    applicationDevice.addEventListener('gattserverdisconnected', handleApplicationDisconnected);
  }

  setState('connectionState', 'Connecting…', 'busy');
  const classification = await attachApplicationServices();
  const selectedName = applicationDevice.name || 'micro:bit';
  setState('connectionState', selectedName, 'good');

  if (classification.mode === 'secure-dfu') {
    setState('modeState', 'Recovery mode', 'warn');
    setState('runtimeState', 'Not available in recovery', 'neutral');
    setState('methodState', 'Full recovery available', 'warn');
    el('progressText').textContent = preparedFirmware
      ? 'micro:bit is already in recovery mode — press Program to finish programming'
      : 'micro:bit is already in recovery mode — choose a HEX file to recover it';
    log(`Connected: ${selectedName} [browser id ${applicationDevice.id}]`);
    log('Live GATT verification found Secure DFU control 0001 and packet 0002. The micro:bit is already in the bootloader; Program will recover it directly without sending Buttonless DFU opcode 0x01.');
  } else {
    setState('modeState', 'Application', 'good');
    setState('runtimeState', 'Not checked', 'neutral');
    setState('methodState', 'Will be selected automatically', 'neutral');
    log(`Connected: ${selectedName} [browser id ${applicationDevice.id}]`);
    if (/^DfuTarg$/i.test(selectedName)) {
      log('The Bluetooth name is stale (DfuTarg), but live application services were verified. Treating this device as a normal micro:bit application.', 'warn');
    }
    log(`Services: ${partialCharacteristic ? 'partial programming' : ''}${partialCharacteristic && buttonlessAvailable ? ' + ' : ''}${buttonlessAvailable ? 'buttonless full DFU' : ''}.`);
  }
  updateButtons();
}
`;
}

function directSecureDfuRecoveryFunction() {
  return `async function runDirectSecureDfuRecovery() {
  if (flashInProgress) return;
  if (!preparedFirmware) throw new Error('Choose a valid micro:bit V2 HEX first');
  if (!applicationDevice?.gatt?.connected || !secureDfuAvailable) {
    throw new Error('Reconnect the micro:bit Secure DFU device before recovery');
  }

  const reason = 'The micro:bit is already in Bluetooth recovery mode. The selected HEX will replace the incomplete application directly; no additional DFU reboot is required.';
  const approvalPromise = requestFullDfuApproval(null, preparedFirmware, reason);
  const confirmButton = el('confirmFullDfu');
  const previousConfirmText = confirmButton?.textContent || 'Enter DFU mode';
  if (confirmButton) confirmButton.textContent = 'Recover program';
  const approved = await approvalPromise;
  if (confirmButton) confirmButton.textContent = previousConfirmText;
  if (!approved) {
    setState('methodState', 'Recovery cancelled', 'neutral');
    el('progressText').textContent = 'Recovery cancelled';
    log('Direct Secure DFU recovery cancelled.', 'warn');
    return;
  }

  // Prepare everything that can fail before locking the UI into an active
  // transfer. This prevents an init-packet preparation error from leaving the
  // page stuck in flashInProgress state.
  const bootloaderDevice = applicationDevice;
  const initPacket = await createMicrobitV2InitPacket(preparedFirmware.applicationBin);
  const packageToFlash = {
    initPacket,
    firmware: preparedFirmware.applicationBin,
    applicationStart: preparedFirmware.applicationStart,
    fileName: selectedFileName,
  };

  flashInProgress = true;
  updateButtons();
  await acquireWakeLock();

  const startedAt = performance.now();
  resetProgress(packageToFlash.firmware.length, 'Recovering micro:bit application…');
  setState('methodState', 'Full application recovery', 'busy');
  setState('modeState', 'Secure DFU recovery', 'busy');
  setState('serviceState', 'Secure DFU 0001 + 0002', 'good');

  const dfu = new NordicSecureDfu({
    log,
    packetDelayMs: 4,
    packetReceiptInterval: 12,
    objectDrainDelayMs: 150,
    progress: event => {
      if (event.type === 'init') {
        setState('connectionState', bootloaderDevice.name || 'DFU bootloader', 'good');
        setState('modeState', 'Secure DFU confirmed', 'good');
        el('progressText').textContent = 'Checking recovery state and validating the DFU init packet…';
        return;
      }
      if (event.type === 'firmware') {
        const total = event.totalBytes || packageToFlash.firmware.length;
        updateProgress(
          Math.min(event.currentBytes, total),
          total,
          startedAt,
          packageToFlash.applicationStart + Math.min(event.currentBytes, total),
          'Full DFU recovery',
        );
      }
    },
  });

  try {
    disconnectPhase = DISCONNECT_PHASE.DFU_TRANSFER;
    log(`The selected device is already a verified Secure DFU bootloader. Recovering ${packageToFlash.fileName} directly without application-mode DFU entry.`);
    await dfu.update(bootloaderDevice, packageToFlash.initPacket, packageToFlash.firmware);
    updateProgress(
      packageToFlash.firmware.length,
      packageToFlash.firmware.length,
      startedAt,
      packageToFlash.applicationStart + packageToFlash.firmware.length,
      'Full DFU recovery',
      true,
    );
    el('progressPercent').textContent = '100%';
    el('progressText').textContent = 'Recovery complete — micro:bit restarting';
    setState('methodState', 'Recovery complete', 'good');
    setState('connectionState', 'Restarting', 'busy');
    log('Secure DFU recovery complete. The application was restored and the micro:bit is restarting.');
    applicationDevice = null;
    partialCharacteristic = null;
    buttonlessAvailable = false;
    secureDfuAvailable = false;
    pendingDfu = null;
    dfuChooserReady = false;
    applicationDeviceIdBeforeDfu = null;
    buttonlessDfuCommandAttempted = false;
    unsupportedDfuCandidateIds.clear();
  } catch (error) {
    log(error.message, 'error');
    el('progressText').textContent = `Recovery stopped: ${error.message}`;
    setState('methodState', 'Recovery retry available', 'warn');
    log('The selected HEX remains loaded. Reconnect the same micro:bit recovery device and press Program again; the bootloader offset and CRC will be checked before any bytes are resumed.', 'warn');
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
    flashInProgress = false;
    await releaseWakeLock();
    updateButtons();
  }
}
`;
}

export function patchAppSourceForLiveGattDeviceState(source, {
  baseUrl,
  version = DEFAULT_VERSION,
} = {}) {
  if (!source || typeof source !== 'string') throw new Error('app.js source is required');
  if (!baseUrl) throw new Error('A base URL is required to rewrite module imports');

  let patched = patchAppSourceForRuntimeIndependentDfu(source, { baseUrl, version });

  if (!patched.includes('let buttonlessAvailable = false;')) {
    throw new Error('Could not add Secure DFU device-state tracking');
  }
  patched = patched.replace(
    'let buttonlessAvailable = false;',
    'let buttonlessAvailable = false;\nlet secureDfuAvailable = false;',
  );

  // Ensure every existing application-state cleanup also clears the direct
  // Secure DFU classification. The global declaration is intentionally not
  // matched because it begins with "let".
  patched = patched.replace(
    /(^\s*)buttonlessAvailable = false;/gm,
    '$1buttonlessAvailable = false;\n$1secureDfuAvailable = false;',
  );

  patched = replaceFunction(
    patched,
    'async function attachApplicationServices() {',
    '\nfunction updateButtons() {',
    liveGattAttachFunction(),
    'live GATT device classification',
  );

  patched = replaceFunction(
    patched,
    'function updateButtons() {',
    '\nfunction showDfuHandoffDialog() {',
    liveGattButtonsFunction(),
    'Secure DFU-aware button state',
  );

  patched = replaceFunction(
    patched,
    'async function connectApplication() {',
    '\nasync function readRegion(regionId) {',
    liveGattConnectFunction(),
    'name-independent micro:bit connection',
  );

  const programMarker = '\nasync function program() {';
  if (!patched.includes(programMarker)) {
    throw new Error('Could not install direct Secure DFU recovery function');
  }
  patched = patched.replace(
    programMarker,
    `\n${directSecureDfuRecoveryFunction()}\nasync function program() {`,
  );

  const programStart = `  if (!applicationDevice?.gatt?.connected) throw new Error('Connect the micro:bit first');\n\n  flashInProgress = true;`;
  const recoveryBranch = `  if (!applicationDevice?.gatt?.connected) throw new Error('Connect the micro:bit first');\n\n  if (secureDfuAvailable) {\n    await runDirectSecureDfuRecovery();\n    return;\n  }\n\n  flashInProgress = true;`;
  if (!patched.includes(programStart)) {
    throw new Error('Could not route Program through direct Secure DFU recovery');
  }
  patched = patched.replace(programStart, recoveryBranch);

  if (!patched.includes("{ namePrefix: 'DfuTarg' }")) {
    throw new Error('DfuTarg was not added to the Connect chooser');
  }
  if (!patched.includes('{ services: [DFU_SERVICE_UUID] }')) {
    throw new Error('Secure DFU service filter was not added to the Connect chooser');
  }
  if (!patched.includes("Secure DFU control 0001 and packet 0002")) {
    throw new Error('Live Secure DFU service classification was not installed');
  }
  if (!patched.includes('await runDirectSecureDfuRecovery();')) {
    throw new Error('Direct Secure DFU recovery route was not installed');
  }

  return patched;
}

export async function loadLiveGattDeviceStateApp({
  version = DEFAULT_VERSION,
  moduleBaseUrl = import.meta.url,
} = {}) {
  const appUrl = new URL('./app.js', moduleBaseUrl);
  appUrl.searchParams.set('v', version);

  const response = await fetch(appUrl, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Could not load app.js for live GATT device-state policy (${response.status})`);
  }

  const originalSource = await response.text();
  const patchedSource = patchAppSourceForLiveGattDeviceState(originalSource, {
    baseUrl: moduleBaseUrl,
    version,
  });

  const sourceWithLabel = `${patchedSource}\n//# sourceURL=${appUrl.href}&device-state-policy=${version}\n`;
  const blobUrl = URL.createObjectURL(new Blob([sourceWithLabel], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
