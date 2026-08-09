const DEFAULT_VERSION = '2.4.7';

function absoluteModuleUrl(baseUrl, path, version) {
  const url = new URL(path, baseUrl);
  url.searchParams.set('v', version);
  return url.href;
}

function replaceFunction(source, functionStart, nextFunctionStart, replacement, label) {
  const start = source.indexOf(functionStart);
  const end = source.indexOf(nextFunctionStart, start);
  if (start < 0 || end < 0) {
    throw new Error(`Could not patch ${label}: expected function boundary was not found`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function runtimeIndependentPairingFunction() {
  return `async function ensurePairingModeForFullDfu(info) {
  // Pairing/programming mode is preparation only. The secured Buttonless DFU
  // transaction is the authority for DFU entry, not the Partial Programming
  // mode byte or runtime hash.
  if (!partialCharacteristic || info?.mode === 0) {
    log('Pairing/programming mode is already active; allowing the Bluetooth stack to settle before bonded DFU setup.');
    await sleep(1200);
    return info;
  }

  el('progressText').textContent = 'Preparing Bluetooth for full DFU…';
  setState('modeState', 'preparing secure DFU', 'busy');
  log('Requesting pairing/programming mode once before full DFU. This is preparation only; bonded 0004 indications and the secured reboot command decide DFU entry.');

  let pairingInfo = info;
  try {
    disconnectPhase = DISCONNECT_PHASE.MODE_SWITCH;
    await writePartialPacket([0xff, 0x00]);
    await reconnectAfterPartialModeSwitch();
    try {
      pairingInfo = await readFlashInfo(preparedFirmware);
    } catch (readError) {
      log(\`Could not confirm the mode after the pairing-mode request (\${readError.message}). Continuing to bonded DFU setup.\`, 'warn');
    }
  } catch (error) {
    log(\`Pairing-mode preparation did not complete (\${error.message}). Continuing to bonded DFU setup if characteristic 0004 is available.\`, 'warn');
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
  }

  if (pairingInfo?.mode === 0) {
    setState('modeState', 'pairing/programming', 'busy');
    el('progressText').textContent = 'Pairing mode active — preparing bonded DFU';
    log('Pairing/programming mode is active. Waiting briefly for the refreshed GATT/security state to settle.');
    await sleep(1500);
  } else {
    setState('modeState', 'application / DFU attempt', 'warn');
    el('progressText').textContent = 'Pairing mode not retained — preparing bonded DFU';
    log('The runtime did not remain in pairing/programming mode. Full DFU will still attempt the Nordic bonded 0004 indication + reboot sequence.', 'warn');
    await sleep(700);
  }

  return pairingInfo || info;
}
`;
}

function nordicBondedTransactionFunction() {
  return `async function establishBondBeforeFullDfu() {
  // Nordic SDK14+ Buttonless DFU with bond sharing requires the client to
  // enable indications on characteristic 0004 before writing Enter Bootloader
  // opcode 0x01. This is a protocol step, not merely a diagnostic bond probe.
  // If enabling indications triggers a pairing/security restart, reconnect once,
  // rediscover 0004 and enable indications again. Once enabled, keep that same
  // GATT connection for the reboot write.
  setState('connectionState', applicationDevice.name || 'Connected', 'good');
  setState('modeState', 'Enabling DFU indications', 'busy');
  el('progressText').textContent = 'Enabling bonded DFU indications';

  const enableIndications = async label => {
    if (!applicationDevice?.gatt) throw new Error('Bluetooth GATT is unavailable for bonded DFU');
    const server = applicationDevice.gatt.connected
      ? applicationDevice.gatt
      : await applicationDevice.gatt.connect();
    const discovered = await discoverDfuService(server);
    const button = discovered?.buttonless;
    if (!button) throw new Error('Buttonless DFU characteristic 0004 is not available');
    if (!button.properties.indicate && !button.properties.notify) {
      throw new Error('Buttonless DFU characteristic 0004 does not expose indications/notifications');
    }

    log(\`Enabling bonded Buttonless DFU indications on 0004 (\${label})…\`);
    await button.startNotifications();
    log(\`Bonded Buttonless DFU indications enabled on 0004 (\${label}).\`);
  };

  let pairingRestartObserved = false;
  let firstError = null;
  disconnectPhase = DISCONNECT_PHASE.BOND_AUTHORIZATION;
  try {
    try {
      await enableIndications('initial connection');
      // A first-time or repaired pairing may complete successfully and then
      // restart the application shortly afterwards. Observe that short window.
      await sleep(800);
      pairingRestartObserved = !applicationDevice?.gatt?.connected;
    } catch (error) {
      firstError = error;
      pairingRestartObserved = !applicationDevice?.gatt?.connected;
      if (!pairingRestartObserved) {
        throw new Error(\`Could not enable bonded DFU indications on 0004: \${error.message}\`);
      }
    }

    if (pairingRestartObserved) {
      log('Bluetooth pairing/security restarted the application while enabling 0004 indications. Reconnecting once and repeating the required indication setup.', 'warn');
      await sleep(1200);

      try {
        await applicationDevice.gatt.connect();
      } catch (error) {
        throw new Error(\`Could not reconnect after the pairing/security restart: \${error.message}\`);
      }

      // Do not attach Partial Programming notifications again here. We want the
      // next GATT operations to be only 0004 indication setup followed by 0x01.
      partialCharacteristic = null;
      buttonlessAvailable = true;
      clearNotificationState(new Error('Bonded DFU reconnect'));
      setState('connectionState', applicationDevice.name || 'Connected', 'good');
      await sleep(600);

      try {
        await enableIndications('after pairing restart');
      } catch (error) {
        const detail = firstError ? \` Initial attempt: \${firstError.message}.\` : '';
        throw new Error(\`Could not enable bonded DFU indications after the one allowed reconnect: \${error.message}.\${detail}\`);
      }

      await sleep(250);
      if (!applicationDevice?.gatt?.connected) {
        throw new Error('The micro:bit disconnected again after bonded DFU indications were enabled');
      }
    }
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
  }

  setState('modeState', 'Bonded DFU ready', 'good');
  el('progressText').textContent = 'Bonded DFU indications enabled — sending reboot command';
  log('Nordic bonded DFU indication setup is complete. Sending opcode 0x01 next on this same GATT connection.');

  return {
    postPairingInfo: null,
    authorization: null,
    authorizationVerified: true,
  };
}
`;
}

export function patchAppSourceForRuntimeIndependentDfu(source, {
  baseUrl,
  version = DEFAULT_VERSION,
} = {}) {
  if (!source || typeof source !== 'string') throw new Error('app.js source is required');
  if (!baseUrl) throw new Error('A base URL is required to rewrite module imports');

  let patched = source;

  patched = patched.replace(
    /from '\.\/core\.js(?:\?v=[^']+)?';/,
    `from '${absoluteModuleUrl(baseUrl, './core.js', version)}';`,
  );
  patched = patched.replace(
    /from '\.\/dfu\.js(?:\?v=[^']+)?';/,
    `from '${absoluteModuleUrl(baseUrl, './dfu.js', version)}';`,
  );
  patched = patched.replace(
    /from '\.\/dfu-entry-state\.js(?:\?v=[^']+)?';/,
    `from '${absoluteModuleUrl(baseUrl, './dfu-entry-state.js', version)}';`,
  );
  patched = patched.replace(
    /const APP_VERSION = '[^']+';/,
    `const APP_VERSION = '${version}';`,
  );

  patched = replaceFunction(
    patched,
    'async function ensurePairingModeForFullDfu(info) {',
    '\nasync function establishBondBeforeFullDfu() {',
    runtimeIndependentPairingFunction(),
    'full-DFU pairing preparation',
  );

  patched = replaceFunction(
    patched,
    'async function establishBondBeforeFullDfu() {',
    '\nasync function prepareAndEnterFullDfu(info, reason) {',
    nordicBondedTransactionFunction(),
    'Nordic bonded DFU transaction',
  );

  // Once 0004 indications have been enabled successfully, do not issue another
  // Partial Programming CCCD operation before opcode 0x01. Keep the same GATT
  // connection and send the reboot command next.
  const postBondQuiesce = `const bondResult = await establishBondBeforeFullDfu();\n  await quiescePartialNotificationsBeforeDfu();`;
  const postBondDirect = `const bondResult = await establishBondBeforeFullDfu();\n  // v2.4.7: keep the secured 0004 connection intact and send opcode 0x01 next.`;
  if (!patched.includes(postBondQuiesce)) {
    throw new Error('Could not patch post-indication DFU sequence');
  }
  patched = patched.replace(postBondQuiesce, postBondDirect);

  const enterCall = `outcome = await enterButtonlessDfu(applicationDevice, {\n      log,\n      skipAuthorization: true,`;
  const enterCallV247 = `outcome = await enterButtonlessDfu(applicationDevice, {\n      log,\n      timeoutMs: 6000,\n      skipAuthorization: true,`;
  if (!patched.includes(enterCall)) {
    throw new Error('Could not patch Buttonless DFU entry timeout/strategy');
  }
  patched = patched.replace(enterCall, enterCallV247);

  patched = patched.replace(
    "setState('modeState', bondResult.authorizationVerified ? 'Bond verified' : 'Bond unverified', bondResult.authorizationVerified ? 'good' : 'warn');",
    "setState('modeState', 'Bonded DFU ready', 'good');",
  );
  patched = patched.replace(
    "el('progressText').textContent = 'Sending one secured Buttonless DFU command';",
    "el('progressText').textContent = 'Sending Buttonless DFU opcode 0x01 on the secured connection';",
  );

  if (!patched.includes(`const APP_VERSION = '${version}';`)) {
    throw new Error('Could not patch app version');
  }
  if (!patched.includes('Nordic bonded DFU indication setup is complete')) {
    throw new Error('Could not install Nordic 0004 indication-first policy');
  }
  if (!patched.includes('authorizationVerified: true')) {
    throw new Error('Bonded indication success is not propagated to the reboot write');
  }
  if (patched.includes('const maxAuthorizationAttempts = 2')) {
    throw new Error('Legacy two-attempt DFU authorization loop is still present after patching');
  }
  if (patched.includes("throw new Error('micro:bit did not enter pairing/programming mode for bonded DFU')")) {
    throw new Error('Legacy pairing-mode gate is still present after patching');
  }

  return patched;
}

export async function loadRuntimeIndependentDfuApp({
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
    throw new Error(`Could not load app.js for DFU policy patch (${response.status})`);
  }

  const originalSource = await response.text();
  const patchedSource = patchAppSourceForRuntimeIndependentDfu(originalSource, {
    baseUrl: moduleBaseUrl,
    version,
  });

  const sourceWithLabel = `${patchedSource}\n//# sourceURL=${appUrl.href}&dfu-policy=${version}\n`;
  const blobUrl = URL.createObjectURL(new Blob([sourceWithLabel], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
