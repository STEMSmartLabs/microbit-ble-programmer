const DEFAULT_VERSION = '2.4.6';

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
  // write is the authority for DFU entry, not the Partial Programming mode byte.
  if (!partialCharacteristic || info?.mode === 0) {
    log('Pairing/programming mode is already active; allowing the Bluetooth stack to settle before the secured DFU write.');
    await sleep(1200);
    return info;
  }

  el('progressText').textContent = 'Preparing Bluetooth for full DFU…';
  setState('modeState', 'preparing secure DFU', 'busy');
  log('Requesting pairing/programming mode once before full DFU. This is preparation only; the actual secured 0004 write decides DFU entry.');

  let pairingInfo = info;
  try {
    disconnectPhase = DISCONNECT_PHASE.MODE_SWITCH;
    await writePartialPacket([0xff, 0x00]);
    await reconnectAfterPartialModeSwitch();
    try {
      pairingInfo = await readFlashInfo(preparedFirmware);
    } catch (readError) {
      log(\`Could not confirm the mode after the pairing-mode request (\${readError.message}). Continuing to the secured DFU write.\`, 'warn');
    }
  } catch (error) {
    log(\`Pairing-mode preparation did not complete (\${error.message}). Continuing to the secured Buttonless DFU write if characteristic 0004 is available.\`, 'warn');
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
  }

  if (pairingInfo?.mode === 0) {
    setState('modeState', 'pairing/programming', 'busy');
    el('progressText').textContent = 'Pairing mode active — preparing one secured DFU write';
    log('Pairing/programming mode is active. Waiting briefly for the refreshed GATT/security state to settle.');
    await sleep(1500);
  } else {
    setState('modeState', 'application / DFU attempt', 'warn');
    el('progressText').textContent = 'Pairing mode not retained — preparing one secured DFU write';
    log('The runtime did not remain in pairing/programming mode. Full DFU will still attempt the real secured 0004 write once.', 'warn');
    await sleep(700);
  }

  return pairingInfo || info;
}
`;
}

function singleSecuredTransactionFunction() {
  return `async function establishBondBeforeFullDfu() {
  // v2.4.6 intentionally does not use startNotifications() on bonded 0004 as a
  // separate authorization probe. On macOS that CCCD operation can trigger a
  // failed/stale bond cycle and disconnect the application before the reboot
  // command is ever attempted. The protected opcode 0x01 write below is itself
  // the security operation and is classified by its real write/reboot result.
  setState('connectionState', applicationDevice.name || 'Connected', 'good');
  setState('modeState', 'Secured DFU command', 'busy');
  el('progressText').textContent = 'Sending one secured DFU reboot command';
  log('Skipping separate 0004 notification authorization probes. The app will perform one real secured Buttonless DFU write on the current connection.');
  await sleep(500);

  return {
    postPairingInfo: null,
    authorization: null,
    authorizationVerified: false,
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
    singleSecuredTransactionFunction(),
    'single secured DFU transaction',
  );

  const enterCall = `outcome = await enterButtonlessDfu(applicationDevice, {\n      log,\n      skipAuthorization: true,`;
  const enterCallV246 = `outcome = await enterButtonlessDfu(applicationDevice, {\n      log,\n      timeoutMs: 6000,\n      skipAuthorization: true,`;
  if (!patched.includes(enterCall)) {
    throw new Error('Could not patch Buttonless DFU entry timeout/strategy');
  }
  patched = patched.replace(enterCall, enterCallV246);

  patched = patched.replace(
    "setState('modeState', bondResult.authorizationVerified ? 'Bond verified' : 'Bond unverified', bondResult.authorizationVerified ? 'good' : 'warn');",
    "setState('modeState', 'Secured DFU command', 'busy');",
  );
  patched = patched.replace(
    "el('progressText').textContent = 'Sending one secured Buttonless DFU command';",
    "el('progressText').textContent = 'Sending one secured Buttonless DFU command directly';",
  );

  if (!patched.includes(`const APP_VERSION = '${version}';`)) {
    throw new Error('Could not patch app version');
  }
  if (!patched.includes('Skipping separate 0004 notification authorization probes')) {
    throw new Error('Could not install single-transaction DFU entry policy');
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
