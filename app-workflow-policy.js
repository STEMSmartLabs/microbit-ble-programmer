import { patchAppSourceForLiveGattDeviceState } from './app-device-state-policy.js?v=2.4.11';

const DEFAULT_VERSION = '2.4.11';

function replaceFunction(source, functionStart, nextFunctionStart, replacement, label) {
  const start = source.indexOf(functionStart);
  const end = source.indexOf(nextFunctionStart, start);
  if (start < 0 || end < 0) {
    throw new Error(`Could not patch ${label}: expected function boundary was not found`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function workflowButtonsFunction() {
  return `function updateButtons() {
  const connected = Boolean(
    applicationDevice?.gatt?.connected
    && (partialCharacteristic || buttonlessAvailable || secureDfuAvailable)
  );
  const browserSelectionNeeded = Boolean(pendingDfu && dfuChooserReady);

  el('connect').disabled = flashInProgress || connectionInProgress || browserSelectionNeeded;
  el('program').disabled = flashInProgress
    || connectionInProgress
    || recoveryReconnectPending
    || (!browserSelectionNeeded && (!connected || !preparedFirmware));
  el('disconnect').disabled = flashInProgress || connectionInProgress || !applicationDevice?.gatt?.connected;
  el('hexFile').disabled = flashInProgress;

  // v2.4.11 keeps only Connect / Program / Disconnect in the customer UI.
  // These legacy controls remain in the DOM because the base application has
  // event listeners for them, but they are never exposed to the user.
  el('selectDfu').hidden = true;
  el('selectDfu').disabled = true;
  el('cancelDfu').hidden = true;
  el('cancelDfu').disabled = true;

  el('connect').textContent = recoveryReconnectPending ? 'Connect' : 'Connect';
  el('program').textContent = 'Program';
  el('disconnect').textContent = 'Disconnect';
}
`;
}

function workflowChooserReadyFunction() {
  return `function markDfuChooserReady() {
  if (!pendingDfu) return;
  dfuChooserReady = true;
  recoveryReconnectPending = false;
  setState('connectionState', 'Ready to continue', 'busy');
  setState('modeState', 'Preparing programming', 'busy');
  el('progressText').textContent = 'Press Program again and select the rebooted micro:bit';
  log('The micro:bit is ready for the browser-required second Bluetooth selection. Press Program again and select the rebooted micro:bit.');
  updateButtons();
  queueMicrotask(() => el('program')?.focus({ preventScroll: false }));
}
`;
}

function workflowConnectFunction() {
  return `async function connectApplication() {
  if (!window.isSecureContext) throw new Error('Web Bluetooth requires HTTPS or localhost');
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser');
  if (connectionInProgress) return;

  connectionInProgress = true;
  updateButtons();

  try {
    if (!applicationDevice) {
      applicationDevice = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'BBC micro:bit' },
          { namePrefix: 'DfuTarg' },
          { services: [DFU_SERVICE_UUID] },
        ],
        optionalServices: [PARTIAL_SERVICE_UUID, DFU_SERVICE_UUID],
      });
      applicationDevice.addEventListener('gattserverdisconnected', handleApplicationDisconnected);
    }

    const selectedDevice = applicationDevice;
    let classification = null;
    let lastError = null;
    const retryDelays = [0, 900, 1500, 2500];

    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      if (retryDelays[attempt]) await sleep(retryDelays[attempt]);
      setState('connectionState', attempt ? 'Reconnecting…' : 'Connecting…', 'busy');
      el('progressText').textContent = attempt
        ? 'Bluetooth was interrupted — reconnecting automatically'
        : 'Connecting to micro:bit…';

      try {
        classification = await attachApplicationServices();
        // A number of macOS failures occur immediately after service discovery.
        // Do not declare success until the link survives a short quiet period.
        await sleep(700);
        if (!selectedDevice.gatt.connected) {
          throw new Error('Bluetooth disconnected during connection setup');
        }
        break;
      } catch (error) {
        lastError = error;
        classification = null;
        partialCharacteristic = null;
        buttonlessAvailable = false;
        secureDfuAvailable = false;
        try { selectedDevice.gatt?.disconnect?.(); } catch {}
        if (attempt < retryDelays.length - 1) {
          log('Bluetooth connection was not stable yet. Reconnecting automatically ('
            + (attempt + 1) + '/' + (retryDelays.length - 1) + ')…', 'warn');
        }
      }
    }

    if (!classification) {
      try { selectedDevice.removeEventListener('gattserverdisconnected', handleApplicationDisconnected); } catch {}
      applicationDevice = null;
      throw new Error('Could not establish a stable Bluetooth connection. Press Connect and select the micro:bit again. Last error: '
        + (lastError?.message || 'unknown Bluetooth error'));
    }

    const selectedName = applicationDevice.name || 'micro:bit';
    setState('connectionState', selectedName, 'good');

    if (classification.mode === 'secure-dfu') {
      setState('modeState', 'Recovery mode', 'warn');
      setState('runtimeState', 'Not available in recovery', 'neutral');
      setState('methodState', 'Recovery ready', 'warn');
      log('Connected: ' + selectedName + ' [browser id ' + applicationDevice.id + ']');
      log('Live Bluetooth services show that the micro:bit is already in recovery mode.');

      if (pendingDfu) {
        recoveryReconnectPending = false;
        dfuChooserReady = false;
        el('progressText').textContent = 'Connection restored — continuing programming automatically';
        log('The interrupted full-programming package is still available. Continuing automatically from the bootloader-reported offset and checksum.');
        const packageToResume = pendingDfu;
        connectionInProgress = false;
        updateButtons();
        await runDirectSecureDfuRecovery({
          packageToFlash: packageToResume,
          skipApproval: true,
        });
        return;
      }

      recoveryReconnectPending = false;
      el('progressText').textContent = preparedFirmware
        ? 'micro:bit is ready for recovery — press Program'
        : 'micro:bit is in recovery mode — choose a HEX file';
    } else {
      if (pendingDfu || recoveryReconnectPending) {
        log('The micro:bit is running its application again. Clearing the interrupted recovery state and returning to normal programming.', 'warn');
        pendingDfu = null;
        dfuChooserReady = false;
        recoveryReconnectPending = false;
      }
      setState('modeState', 'Ready', 'good');
      setState('runtimeState', 'Not checked', 'neutral');
      setState('methodState', 'Automatic', 'neutral');
      el('progressText').textContent = preparedFirmware
        ? 'Connected — press Program'
        : 'Connected — choose a HEX file';
      log('Connected: ' + selectedName + ' [browser id ' + applicationDevice.id + ']');
      if (/^DfuTarg$/i.test(selectedName)) {
        log('Chrome retained the recovery name, but live application services were verified. Continuing normally.', 'warn');
      }
      log('Services: '
        + (partialCharacteristic ? 'partial programming' : '')
        + (partialCharacteristic && buttonlessAvailable ? ' + ' : '')
        + (buttonlessAvailable ? 'full programming' : '')
        + '.');
    }
  } finally {
    connectionInProgress = false;
    updateButtons();
  }
}
`;
}

function directRecoveryFunction() {
  return `async function runDirectSecureDfuRecovery({ packageToFlash = null, skipApproval = false } = {}) {
  if (flashInProgress) return;
  if (!applicationDevice?.gatt?.connected || !secureDfuAvailable) {
    throw new Error('Reconnect the micro:bit before recovery');
  }

  let recoveryPackage = packageToFlash;
  if (!recoveryPackage) {
    if (!preparedFirmware) throw new Error('Choose a valid micro:bit V2 HEX first');
    if (!skipApproval) {
      const reason = 'The micro:bit is already in Bluetooth recovery mode. The selected program will restore the application directly.';
      const approvalPromise = requestFullDfuApproval(null, preparedFirmware, reason);
      const confirmButton = el('confirmFullDfu');
      const previousConfirmText = confirmButton?.textContent || 'Continue';
      if (confirmButton) confirmButton.textContent = 'Program';
      const approved = await approvalPromise;
      if (confirmButton) confirmButton.textContent = previousConfirmText;
      if (!approved) {
        setState('methodState', 'Cancelled', 'neutral');
        el('progressText').textContent = 'Programming cancelled';
        log('Recovery programming cancelled.', 'warn');
        return;
      }
    }

    const initPacket = await createMicrobitV2InitPacket(preparedFirmware.applicationBin);
    recoveryPackage = {
      initPacket,
      firmware: preparedFirmware.applicationBin,
      applicationStart: preparedFirmware.applicationStart,
      fileName: selectedFileName,
      entryConfidence: 'recovery',
    };
  }

  flashInProgress = true;
  recoveryReconnectPending = false;
  updateButtons();
  await acquireWakeLock();

  const bootloaderDevice = applicationDevice;
  const startedAt = performance.now();
  resetProgress(recoveryPackage.firmware.length, 'Restoring micro:bit program…');
  setState('methodState', 'Programming', 'busy');
  setState('modeState', 'Recovery', 'busy');

  const dfu = new NordicSecureDfu({
    log,
    packetDelayMs: 4,
    packetReceiptInterval: 12,
    objectDrainDelayMs: 150,
    progress: event => {
      if (event.type === 'init') {
        setState('connectionState', bootloaderDevice.name || 'micro:bit', 'good');
        el('progressText').textContent = 'Preparing program transfer…';
        return;
      }
      if (event.type === 'firmware') {
        const total = event.totalBytes || recoveryPackage.firmware.length;
        updateProgress(
          Math.min(event.currentBytes, total),
          total,
          startedAt,
          recoveryPackage.applicationStart + Math.min(event.currentBytes, total),
          'Programming',
        );
      }
    },
  });

  try {
    disconnectPhase = DISCONNECT_PHASE.DFU_TRANSFER;
    log('Continuing full application programming directly from the verified recovery bootloader.');
    await dfu.update(bootloaderDevice, recoveryPackage.initPacket, recoveryPackage.firmware);
    updateProgress(
      recoveryPackage.firmware.length,
      recoveryPackage.firmware.length,
      startedAt,
      recoveryPackage.applicationStart + recoveryPackage.firmware.length,
      'Programming',
      true,
    );
    el('progressPercent').textContent = '100%';
    el('progressText').textContent = 'Programming complete — micro:bit restarting';
    setState('methodState', 'Complete', 'good');
    setState('connectionState', 'Restarting', 'busy');
    log('Full application programming complete.');
    pendingDfu = null;
    dfuChooserReady = false;
    recoveryReconnectPending = false;
    applicationDeviceIdBeforeDfu = null;
    buttonlessDfuCommandAttempted = false;
    unsupportedDfuCandidateIds.clear();
    applicationDevice = null;
    partialCharacteristic = null;
    buttonlessAvailable = false;
    secureDfuAvailable = false;
  } catch (error) {
    pendingDfu = recoveryPackage;
    dfuChooserReady = false;
    recoveryReconnectPending = true;
    try { bootloaderDevice?.gatt?.disconnect?.(); } catch {}
    applicationDevice = null;
    partialCharacteristic = null;
    buttonlessAvailable = false;
    secureDfuAvailable = false;
    setState('connectionState', 'Reconnect', 'warn');
    setState('modeState', 'Recovery', 'warn');
    setState('methodState', 'Waiting to reconnect', 'warn');
    el('progressText').textContent = 'Bluetooth was interrupted — press Connect to continue';
    log(error.message, 'error');
    log('Bluetooth could not be recovered with the current browser device. Press Connect once, select the micro:bit, and programming will continue automatically if recovery mode is detected.', 'warn');
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
    flashInProgress = false;
    await releaseWakeLock();
    updateButtons();
  }
}
`;
}

function partialRecoveryHelpers() {
  return `function isTransientBluetoothProgrammingError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('bluetooth disconnected')
    || text.includes('gatt')
    || text.includes('connection attempt failed')
    || text.includes('device disconnected')
    || text.includes('networkerror')
    || text.includes('timed out waiting for micro:bit response');
}

async function reconnectApplicationForPartialRetry() {
  if (!applicationDevice?.gatt) throw new Error('The selected micro:bit is no longer available');
  const delays = [900, 1400, 2200, 3200];
  let lastError = null;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    await sleep(delays[attempt]);
    setState('connectionState', 'Reconnecting…', 'busy');
    el('progressText').textContent = 'Bluetooth was interrupted — reconnecting automatically';
    try {
      await attachApplicationServices();
      await sleep(500);
      if (!applicationDevice.gatt.connected || !partialCharacteristic) {
        throw new Error('Partial programming service is not ready after reconnect');
      }
      log('Bluetooth reconnected automatically. Rechecking the micro:bit before restarting the transfer.');
      return;
    } catch (error) {
      lastError = error;
      partialCharacteristic = null;
      buttonlessAvailable = false;
      secureDfuAvailable = false;
      try { applicationDevice.gatt.disconnect(); } catch {}
    }
  }

  throw new Error('Automatic reconnect did not succeed: ' + (lastError?.message || 'unknown Bluetooth error'));
}

async function runPartialFlashWithRecovery(info) {
  try {
    await runPartialFlash(info);
    return;
  } catch (error) {
    if (!isTransientBluetoothProgrammingError(error) || partialRetryUsed) throw error;
    partialRetryUsed = true;
    log('Bluetooth was interrupted during fast programming. Reconnecting and restarting this transfer once automatically.', 'warn');
    await reconnectApplicationForPartialRetry();

    const refreshed = await readFlashInfo(preparedFirmware);
    if (!refreshed?.runtimeMatches || !refreshed?.layoutMatches) {
      throw new Error('The micro:bit layout changed after reconnect; automatic partial retry was stopped safely');
    }

    // A failed partial transfer can update the advertised program hash before
    // the complete program region has actually arrived. Force a full restart of
    // the partial transfer instead of trusting programMatches after recovery.
    refreshed.programMatches = false;
    setState('connectionState', applicationDevice.name || 'Connected', 'good');
    el('progressText').textContent = 'Connection restored — restarting programming';
    await runPartialFlash(refreshed);
  }
}
`;
}

function workflowProgramFunction() {
  return `async function program() {
  if (flashInProgress) return log('Programming already in progress; duplicate click ignored.', 'warn');
  if (!preparedFirmware) throw new Error('Choose a valid micro:bit V2 HEX first');

  // Web Bluetooth requires a user gesture for the application-to-bootloader
  // chooser. v2.4.11 reuses the same Program button instead of exposing a
  // separate Continue/DFU control.
  if (pendingDfu && dfuChooserReady) {
    await selectDfuAndFlash();
    return;
  }

  if (recoveryReconnectPending) {
    throw new Error('Press Connect first so programming can resume');
  }
  if (!applicationDevice?.gatt?.connected) throw new Error('Connect the micro:bit first');

  if (secureDfuAvailable) {
    await runDirectSecureDfuRecovery();
    return;
  }

  partialRetryUsed = false;
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
      await runPartialFlashWithRecovery(info);
      return;
    }

    let reason;
    if (!partialCharacteristic) {
      reason = 'This program requires a full wireless update.';
    } else if (!preparedFirmware.markerCandidates.length) {
      reason = 'This program requires a full wireless update.';
    } else if (!info?.layoutMatches) {
      reason = 'This program uses a different application layout and requires a full wireless update.';
    } else {
      reason = 'This program uses a different runtime and requires a full wireless update.';
    }

    await prepareAndEnterFullDfu(info, reason);
  } catch (error) {
    log(error.message, 'error');
    el('progressText').textContent = 'Stopped: ' + error.message;
  } finally {
    flashInProgress = false;
    await releaseWakeLock();
    updateButtons();
    if (dfuChooserReady) {
      queueMicrotask(() => el('program')?.focus({ preventScroll: false }));
    }
  }
}
`;
}

function workflowDfuSelectionFunction() {
  return `async function selectDfuAndFlash() {
  if (!pendingDfu) throw new Error('No full programming transfer is pending');
  if (!dfuChooserReady) throw new Error('Wait for the micro:bit to finish preparing');
  if (flashInProgress) return;

  // Keep requestDevice as the first awaited operation so this remains directly
  // attached to the Program button user gesture.
  const bootloaderDevice = await requestDfuDevice();
  log('Selected programming device: ' + (bootloaderDevice.name || '(unnamed device)')
    + ' [browser id ' + bootloaderDevice.id + '].');

  if (unsupportedDfuCandidateIds.has(bootloaderDevice.id)) {
    pendingDfu = pendingDfu;
    dfuChooserReady = false;
    recoveryReconnectPending = true;
    applicationDevice = null;
    throw new Error('This cached Bluetooth entry is unavailable. Press Connect and select the micro:bit again.');
  }

  flashInProgress = true;
  recoveryReconnectPending = false;
  updateButtons();
  await acquireWakeLock();

  const startedAt = performance.now();
  const packageToFlash = pendingDfu;
  resetProgress(packageToFlash.firmware.length, 'Connecting to the rebooted micro:bit…');
  setState('connectionState', 'Connecting…', 'busy');
  setState('modeState', 'Preparing programming', 'busy');

  const dfu = new NordicSecureDfu({
    log,
    packetDelayMs: 4,
    packetReceiptInterval: 12,
    objectDrainDelayMs: 150,
    progress: event => {
      if (event.type === 'init') {
        setState('connectionState', bootloaderDevice.name || 'micro:bit', 'good');
        setState('modeState', 'Programming', 'good');
        el('progressText').textContent = 'Preparing program transfer…';
        return;
      }
      if (event.type === 'firmware') {
        const total = event.totalBytes || packageToFlash.firmware.length;
        updateProgress(
          Math.min(event.currentBytes, total),
          total,
          startedAt,
          packageToFlash.applicationStart + Math.min(event.currentBytes, total),
          'Programming',
        );
      }
    },
  });

  try {
    setState('methodState', 'Programming', 'busy');
    disconnectPhase = DISCONNECT_PHASE.DFU_TRANSFER;
    log('Starting full application programming for ' + packageToFlash.fileName + '.');
    await dfu.update(bootloaderDevice, packageToFlash.initPacket, packageToFlash.firmware);
    updateProgress(
      packageToFlash.firmware.length,
      packageToFlash.firmware.length,
      startedAt,
      packageToFlash.applicationStart + packageToFlash.firmware.length,
      'Programming',
      true,
    );
    el('progressPercent').textContent = '100%';
    el('progressText').textContent = 'Programming complete — micro:bit restarting';
    setState('methodState', 'Complete', 'good');
    setState('connectionState', 'Restarting', 'busy');
    log('Full application programming complete.');
    pendingDfu = null;
    dfuChooserReady = false;
    recoveryReconnectPending = false;
    applicationDeviceIdBeforeDfu = null;
    buttonlessDfuCommandAttempted = false;
    unsupportedDfuCandidateIds.clear();
    applicationDevice = null;
    partialCharacteristic = null;
    buttonlessAvailable = false;
    secureDfuAvailable = false;
  } catch (error) {
    if (error?.code === 'DFU_CANDIDATE_UNSUPPORTED' || /^Unsupported device\b/i.test(error?.message || '')) {
      unsupportedDfuCandidateIds.add(bootloaderDevice.id);
    }

    log(error.message, 'error');

    if (error?.code === 'DFU_CANDIDATE_APPLICATION') {
      pendingDfu = null;
      dfuChooserReady = false;
      recoveryReconnectPending = false;
      applicationDevice = null;
      partialCharacteristic = null;
      buttonlessAvailable = false;
      secureDfuAvailable = false;
      setState('connectionState', 'Reconnect', 'warn');
      setState('modeState', 'Ready to reconnect', 'warn');
      setState('methodState', 'Retry available', 'warn');
      el('progressText').textContent = 'The micro:bit returned to normal mode — press Connect';
      log('The selected device is running the normal application rather than the programming bootloader. Press Connect and retry Program.', 'warn');
    } else {
      // Once the browser-selected bootloader identity becomes unconnectable,
      // repeatedly reopening the same chooser is not useful on macOS. Preserve
      // the package, discard the stale BluetoothDevice, and let Connect obtain a
      // fresh live identity. If it exposes 0001+0002, Connect resumes automatically.
      pendingDfu = packageToFlash;
      dfuChooserReady = false;
      recoveryReconnectPending = true;
      try { bootloaderDevice?.gatt?.disconnect?.(); } catch {}
      applicationDevice = null;
      partialCharacteristic = null;
      buttonlessAvailable = false;
      secureDfuAvailable = false;
      setState('connectionState', 'Reconnect', 'warn');
      setState('modeState', 'Recovery', 'warn');
      setState('methodState', 'Waiting to reconnect', 'warn');
      el('progressText').textContent = 'Bluetooth was interrupted — press Connect to continue';
      log('The current browser Bluetooth identity could not be recovered. Press Connect once and select the micro:bit; if it is still in recovery mode, programming will continue automatically.', 'warn');
    }
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
    flashInProgress = false;
    await releaseWakeLock();
    updateButtons();
  }
}
`;
}

export function patchAppSourceForSimplifiedWorkflow(source, {
  baseUrl,
  version = DEFAULT_VERSION,
} = {}) {
  let patched = patchAppSourceForLiveGattDeviceState(source, { baseUrl, version });

  if (!patched.includes('let secureDfuAvailable = false;')) {
    throw new Error('Live GATT device-state policy must be installed before workflow patching');
  }
  patched = patched.replace(
    'let secureDfuAvailable = false;',
    'let secureDfuAvailable = false;\nlet connectionInProgress = false;\nlet partialRetryUsed = false;\nlet recoveryReconnectPending = false;',
  );

  patched = replaceFunction(
    patched,
    'function updateButtons() {',
    '\nfunction showDfuHandoffDialog() {',
    workflowButtonsFunction(),
    'simplified button workflow',
  );

  patched = replaceFunction(
    patched,
    'function markDfuChooserReady() {',
    '\nfunction handleApplicationDisconnected() {',
    workflowChooserReadyFunction(),
    'Program-button DFU handoff',
  );

  patched = replaceFunction(
    patched,
    'async function connectApplication() {',
    '\nasync function readRegion(regionId) {',
    workflowConnectFunction(),
    'self-healing Connect flow',
  );

  patched = replaceFunction(
    patched,
    'async function runDirectSecureDfuRecovery(',
    '\nasync function program() {',
    directRecoveryFunction(),
    'direct recovery reconnect workflow',
  );

  const programMarker = '\nasync function program() {';
  if (!patched.includes(programMarker)) {
    throw new Error('Could not install partial recovery helpers');
  }
  patched = patched.replace(
    programMarker,
    '\n' + partialRecoveryHelpers() + '\nasync function program() {',
  );

  patched = replaceFunction(
    patched,
    'async function program() {',
    '\nasync function selectDfuAndFlash() {',
    workflowProgramFunction(),
    'simplified Program workflow',
  );

  patched = replaceFunction(
    patched,
    'async function selectDfuAndFlash() {',
    '\nasync function loadHexFile(file) {',
    workflowDfuSelectionFunction(),
    'fresh-identity DFU recovery workflow',
  );

  // Loading another HEX intentionally replaces any interrupted package.
  patched = patched.replace(
    'pendingDfu = null;\n  dfuChooserReady = false;\n  applicationDeviceIdBeforeDfu = null;',
    'pendingDfu = null;\n  dfuChooserReady = false;\n  recoveryReconnectPending = false;\n  partialRetryUsed = false;\n  applicationDeviceIdBeforeDfu = null;',
  );

  // Explicit Disconnect always abandons any automatic recovery state.
  patched = patched.replace(
    'pendingDfu = null;\n  dfuChooserReady = false;\n  applicationDeviceIdBeforeDfu = null;\n  buttonlessDfuCommandAttempted = false;\n  disconnectPhase = DISCONNECT_PHASE.NONE;',
    'pendingDfu = null;\n  dfuChooserReady = false;\n  recoveryReconnectPending = false;\n  partialRetryUsed = false;\n  applicationDeviceIdBeforeDfu = null;\n  buttonlessDfuCommandAttempted = false;\n  disconnectPhase = DISCONNECT_PHASE.NONE;',
  );

  if (!patched.includes('let connectionInProgress = false;')) {
    throw new Error('Connect concurrency guard was not installed');
  }
  if (!patched.includes('runPartialFlashWithRecovery')) {
    throw new Error('Partial-flash automatic recovery was not installed');
  }
  if (!patched.includes('Press Connect once and select the micro:bit')) {
    throw new Error('Fresh-identity recovery fallback was not installed');
  }
  if (!patched.includes('if (pendingDfu && dfuChooserReady)')) {
    throw new Error('Program button does not own the second Bluetooth chooser');
  }

  return patched;
}

export async function loadSimplifiedWorkflowApp({
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
    throw new Error(`Could not load app.js for simplified workflow (${response.status})`);
  }

  const originalSource = await response.text();
  const patchedSource = patchAppSourceForSimplifiedWorkflow(originalSource, {
    baseUrl: moduleBaseUrl,
    version,
  });
  const sourceWithLabel = patchedSource
    + '\n//# sourceURL=' + appUrl.href
    + '&workflow-policy=' + version + '\n';
  const blobUrl = URL.createObjectURL(new Blob([sourceWithLabel], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
