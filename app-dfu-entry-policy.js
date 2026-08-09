const DEFAULT_VERSION = '2.4.5';

function replaceExactlyOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`Could not patch ${label}: expected source was not found`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Could not patch ${label}: expected source appears more than once`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function absoluteModuleUrl(baseUrl, path, version) {
  const url = new URL(path, baseUrl);
  url.searchParams.set('v', version);
  return url.href;
}

function runtimeIndependentPairingFunction() {
  return `async function ensurePairingModeForFullDfu(info) {
  // Entering pairing/programming mode is useful because it can repair a stale
  // host bond, but it is not a prerequisite for attempting Buttonless DFU.
  // MakeCode runtimes may immediately return to application mode after the
  // reset, especially when the host already has an old bond. Full DFU must
  // therefore be driven by the real secured 0004 write/reboot outcome rather
  // than by the Partial Programming Service mode byte.
  if (!partialCharacteristic || info?.mode === 0) return info;

  el('progressText').textContent = 'Preparing Bluetooth security for full DFU…';
  setState('modeState', 'preparing secure DFU', 'busy');
  log('Requesting pairing/programming mode before full DFU. This is best-effort and will not block the actual Buttonless DFU command if the runtime returns to application mode.');

  let pairingInfo = info;
  try {
    disconnectPhase = DISCONNECT_PHASE.MODE_SWITCH;
    await writePartialPacket([0xff, 0x00]);
    await reconnectAfterPartialModeSwitch();
    try {
      pairingInfo = await readFlashInfo(preparedFirmware);
    } catch (readError) {
      log(\`Could not confirm the application mode after the pairing-mode request (\${readError.message}). Continuing to direct Buttonless DFU authorization.\`, 'warn');
    }
  } catch (error) {
    log(\`Pairing-mode preparation did not complete (\${error.message}). Continuing to direct Buttonless DFU authorization on characteristic 0004.\`, 'warn');
  } finally {
    disconnectPhase = DISCONNECT_PHASE.NONE;
  }

  if (pairingInfo?.mode === 0) {
    setState('modeState', 'pairing/programming', 'busy');
    el('progressText').textContent = 'Pairing mode active — checking secured DFU access';
    log('Pairing/programming mode is active. The app will now test secured Buttonless DFU access.');
    await sleep(900);
  } else {
    setState('modeState', 'application / DFU attempt', 'warn');
    el('progressText').textContent = 'Pairing mode not retained — trying the real secured DFU command';
    log('The runtime did not remain in pairing/programming mode. This no longer blocks full DFU; the app will attempt the real bonded Buttonless DFU operation and classify the actual write/reboot result.', 'warn');
    await sleep(350);
  }

  return pairingInfo || info;
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

  const functionStart = 'async function ensurePairingModeForFullDfu(info) {';
  const nextFunction = '\nasync function establishBondBeforeFullDfu() {';
  const start = patched.indexOf(functionStart);
  const end = patched.indexOf(nextFunction, start);
  if (start < 0 || end < 0) {
    throw new Error('Could not patch full-DFU pairing policy: ensurePairingModeForFullDfu() was not found');
  }

  patched = patched.slice(0, start)
    + runtimeIndependentPairingFunction()
    + patched.slice(end);

  if (!patched.includes(`const APP_VERSION = '${version}';`)) {
    throw new Error('Could not patch app version');
  }
  if (!patched.includes('This no longer blocks full DFU')) {
    throw new Error('Could not install runtime-independent DFU pairing policy');
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
