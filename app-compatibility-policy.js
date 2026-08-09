import { patchAppSourceForResetRecovery } from './app-recovery-policy.js?v=2.4.13';

const DEFAULT_VERSION = '2.4.13';
const BONDED_DFU_ACCESS_UNAVAILABLE = 'BONDED_DFU_ACCESS_UNAVAILABLE';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Could not patch ${label}: expected source was not found`);
  }
  return source.replace(before, after);
}

export function patchAppSourceForBondedDfuCompatibility(source, {
  baseUrl,
  version = DEFAULT_VERSION,
} = {}) {
  let patched = patchAppSourceForResetRecovery(source, { baseUrl, version });

  // Only classify the terminal security case: the protected 0004 CCCD failed,
  // pairing/security restarted the application, the app reconnected once, and
  // enabling 0004 failed again. A single transient 0004 failure is deliberately
  // left untouched so it can still be retried normally.
  const terminalBondedFailure = "        throw new Error(`Could not enable bonded DFU indications after the one allowed reconnect: ${error.message}.${detail}`);";
  const classifiedBondedFailure = `        const compatibilityError = new Error(\`Could not enable bonded DFU indications after the one allowed reconnect: \${error.message}.\${detail}\`);
        compatibilityError.code = '${BONDED_DFU_ACCESS_UNAVAILABLE}';
        throw compatibilityError;`;

  patched = replaceOnce(
    patched,
    terminalBondedFailure,
    classifiedBondedFailure,
    'terminal bonded DFU access classification',
  );

  const genericProgramCatch = `  } catch (error) {
    log(error.message, 'error');
    el('progressText').textContent = 'Stopped: ' + error.message;
  } finally {`;

  const compatibilityAwareCatch = `  } catch (error) {
    if (error?.code === '${BONDED_DFU_ACCESS_UNAVAILABLE}') {
      log(error.message, 'error');
      log('${BONDED_DFU_ACCESS_UNAVAILABLE}: the installed Bluetooth runtime could not enable protected full-programming access after the allowed pairing/security restart and reconnect. Wireless full programming is stopped for this setup.', 'error');
      log('Use USB once to install the approved Bluetooth base program. Then return to this page, press Connect and program wirelessly as normal.', 'warn');
      setState('connectionState', 'USB setup needed', 'warn');
      setState('modeState', 'Bluetooth setup unsupported', 'warn');
      setState('methodState', 'USB setup required once', 'warn');
      el('progressText').textContent = 'Use USB once to install the Bluetooth base program, then Connect again';
      try { applicationDevice?.gatt?.disconnect?.(); } catch {}
      applicationDevice = null;
      partialCharacteristic = null;
      buttonlessAvailable = false;
      secureDfuAvailable = false;
      pendingDfu = null;
      dfuChooserReady = false;
      recoveryReconnectPending = false;
      recoveryConnectFailures = 0;
      return;
    }

    log(error.message, 'error');
    el('progressText').textContent = 'Stopped: ' + error.message;
  } finally {`;

  patched = replaceOnce(
    patched,
    genericProgramCatch,
    compatibilityAwareCatch,
    'customer compatibility guidance',
  );

  if (!patched.includes(`compatibilityError.code = '${BONDED_DFU_ACCESS_UNAVAILABLE}'`)) {
    throw new Error('Terminal bonded DFU access error was not classified');
  }
  if (!patched.includes('USB setup required once')) {
    throw new Error('USB provisioning guidance was not installed');
  }
  if (!patched.includes('Use USB once to install the approved Bluetooth base program')) {
    throw new Error('Approved Bluetooth base program guidance was not installed');
  }

  return patched;
}

export async function loadBondedDfuCompatibilityApp({
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
    throw new Error(`Could not load app.js for bonded DFU compatibility policy (${response.status})`);
  }

  const originalSource = await response.text();
  const patchedSource = patchAppSourceForBondedDfuCompatibility(originalSource, {
    baseUrl: moduleBaseUrl,
    version,
  });
  const sourceWithLabel = patchedSource
    + '\n//# sourceURL=' + appUrl.href
    + '&bonded-dfu-compatibility=' + version + '\n';
  const blobUrl = URL.createObjectURL(new Blob([sourceWithLabel], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
