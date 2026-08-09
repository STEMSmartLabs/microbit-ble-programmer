import { patchAppSourceForSimplifiedWorkflow } from './app-workflow-policy.js?v=2.4.12';

const DEFAULT_VERSION = '2.4.12';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Could not patch ${label}: expected source was not found`);
  }
  return source.replace(before, after);
}

export function patchAppSourceForResetRecovery(source, {
  baseUrl,
  version = DEFAULT_VERSION,
} = {}) {
  let patched = patchAppSourceForSimplifiedWorkflow(source, { baseUrl, version });

  patched = replaceOnce(
    patched,
    'let recoveryReconnectPending = false;',
    'let recoveryReconnectPending = false;\nlet recoveryConnectFailures = 0;',
    'recovery connection counter',
  );

  patched = replaceOnce(
    patched,
    'const retryDelays = [0, 900, 1500, 2500];',
    "const retryDelays = recoveryReconnectPending ? [0, 1200] : [0, 900, 1500, 2500];",
    'short recovery reconnect sequence',
  );

  const failedConnect = `    if (!classification) {
      try { selectedDevice.removeEventListener('gattserverdisconnected', handleApplicationDisconnected); } catch {}
      applicationDevice = null;
      throw new Error('Could not establish a stable Bluetooth connection. Press Connect and select the micro:bit again. Last error: '
        + (lastError?.message || 'unknown Bluetooth error'));
    }`;

  const recoveryAwareFailedConnect = `    if (!classification) {
      const recoveringInterruptedProgram = Boolean(recoveryReconnectPending && pendingDfu);
      try { selectedDevice.removeEventListener('gattserverdisconnected', handleApplicationDisconnected); } catch {}
      applicationDevice = null;

      if (recoveringInterruptedProgram) {
        recoveryConnectFailures++;
        setState('connectionState', 'Reset then Connect', 'warn');
        setState('modeState', 'Recovery', 'warn');
        setState('methodState', 'Waiting for reset', 'warn');
        el('progressText').textContent = 'Press the micro:bit reset button once, then press Connect';
        log('The interrupted-program Bluetooth identity is not accepting a GATT connection. Press the micro:bit reset button once, then press Connect. If it returns to recovery mode, programming will resume automatically; if it returns to the application, Program will safely start the full update again.', 'warn');
        throw new Error('Recovery connection is temporarily unavailable. Press the micro:bit reset button once, then press Connect. Last error: '
          + (lastError?.message || 'unknown Bluetooth error'));
      }

      throw new Error('Could not establish a stable Bluetooth connection. Press Connect and select the micro:bit again. Last error: '
        + (lastError?.message || 'unknown Bluetooth error'));
    }`;

  patched = replaceOnce(
    patched,
    failedConnect,
    recoveryAwareFailedConnect,
    'reset guidance after failed recovery Connect',
  );

  patched = replaceOnce(
    patched,
    `    if (classification.mode === 'secure-dfu') {
      setState('modeState', 'Recovery mode', 'warn');`,
    `    if (classification.mode === 'secure-dfu') {
      recoveryConnectFailures = 0;
      setState('modeState', 'Recovery mode', 'warn');`,
    'recovery counter reset in Secure DFU',
  );

  patched = replaceOnce(
    patched,
    `    } else {
      if (pendingDfu || recoveryReconnectPending) {
        log('The micro:bit is running its application again. Clearing the interrupted recovery state and returning to normal programming.', 'warn');`,
    `    } else {
      recoveryConnectFailures = 0;
      if (pendingDfu || recoveryReconnectPending) {
        log('The micro:bit is running its application again. Clearing the interrupted recovery state and returning to normal programming.', 'warn');`,
    'recovery counter reset in application mode',
  );

  patched = patched.replaceAll(
    "el('progressText').textContent = 'Bluetooth was interrupted — press Connect to continue';",
    "el('progressText').textContent = 'Programming was interrupted — press reset once, then Connect';",
  );

  patched = patched.replaceAll(
    "log('Bluetooth could not be recovered with the current browser device. Press Connect once, select the micro:bit, and programming will continue automatically if recovery mode is detected.', 'warn');",
    "log('Bluetooth could not be recovered with the current browser device. Press the micro:bit reset button once, then press Connect. The selected program remains prepared for recovery.', 'warn');",
  );

  patched = patched.replaceAll(
    "log('The current browser Bluetooth identity could not be recovered. Press Connect once and select the micro:bit; if it is still in recovery mode, programming will continue automatically.', 'warn');",
    "log('The current browser Bluetooth identity could not be recovered. Press the micro:bit reset button once, then press Connect. If the micro:bit is still in recovery mode, programming will continue automatically; if it returned to its application, retry Program normally.', 'warn');",
  );

  // Loading a new HEX or explicitly disconnecting abandons the old recovery
  // guidance and starts with a clean counter.
  patched = patched.replaceAll(
    'recoveryReconnectPending = false;\n  partialRetryUsed = false;',
    'recoveryReconnectPending = false;\n  recoveryConnectFailures = 0;\n  partialRetryUsed = false;',
  );

  if (!patched.includes('Press the micro:bit reset button once, then press Connect')) {
    throw new Error('Reset-and-Connect recovery guidance was not installed');
  }
  if (!patched.includes('recoveryReconnectPending ? [0, 1200]')) {
    throw new Error('Recovery Connect retry reduction was not installed');
  }
  if (!patched.includes('let recoveryConnectFailures = 0;')) {
    throw new Error('Recovery connection state was not installed');
  }

  return patched;
}

export async function loadResetRecoveryApp({
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
    throw new Error(`Could not load app.js for reset recovery policy (${response.status})`);
  }

  const originalSource = await response.text();
  const patchedSource = patchAppSourceForResetRecovery(originalSource, {
    baseUrl: moduleBaseUrl,
    version,
  });
  const sourceWithLabel = patchedSource
    + '\n//# sourceURL=' + appUrl.href
    + '&reset-recovery-policy=' + version + '\n';
  const blobUrl = URL.createObjectURL(new Blob([sourceWithLabel], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
