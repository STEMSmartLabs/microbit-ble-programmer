import { patchAppSourceForResetRecovery } from './app-recovery-policy.js?v=2.4.16';

const DEFAULT_VERSION = '2.4.16';
const BONDED_DFU_ACCESS_UNAVAILABLE = 'BONDED_DFU_ACCESS_UNAVAILABLE';
const ANDROID_DFU_AUTHORIZATION_REQUIRED = 'ANDROID_DFU_AUTHORIZATION_REQUIRED';

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

  patched = replaceOnce(
    patched,
    'let recoveryConnectFailures = 0;',
    'let recoveryConnectFailures = 0;\nlet androidAuthorizationRefreshRequired = false;',
    'Android authorization refresh state',
  );

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

  // Once Android reports protected Secure DFU responses as unauthorized,
  // recovery mode must not automatically resume the pending package again.
  // Only a return to the normal application clears this gate.
  patched = replaceOnce(
    patched,
    `      if (pendingDfu) {
        recoveryReconnectPending = false;`,
    `      if (androidAuthorizationRefreshRequired) {
        recoveryReconnectPending = true;
        dfuChooserReady = false;
        setState('connectionState', 'Power cycle needed', 'warn');
        setState('modeState', 'Waiting for application', 'warn');
        setState('methodState', 'Android recovery', 'warn');
        el('progressText').textContent = 'Power the micro:bit off and on, enter pairing mode if needed, then Connect';
        log('Android authorization refresh is still required. Recovery mode was detected again, so the pending program will NOT auto-resume. Power the micro:bit off and on, enter Bluetooth pairing mode if needed, then press Connect. Continue only after the normal application is detected.', 'warn');
        return;
      }

      if (pendingDfu) {
        recoveryReconnectPending = false;`,
    'block Android recovery auto-resume until application returns',
  );

  patched = replaceOnce(
    patched,
    `    } else {
      recoveryConnectFailures = 0;
      if (pendingDfu || recoveryReconnectPending) {`,
    `    } else {
      recoveryConnectFailures = 0;
      if (androidAuthorizationRefreshRequired) {
        androidAuthorizationRefreshRequired = false;
        log('Normal application services are visible again after the Android power cycle. Bluetooth authorization refresh is complete; normal programming can continue.', 'good');
      }
      if (pendingDfu || recoveryReconnectPending) {`,
    'clear Android authorization gate only in application mode',
  );

  const directRecoveryCatch = `  } catch (error) {
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
    el('progressText').textContent = 'Programming was interrupted — press reset once, then Connect';
    log(error.message, 'error');
    log('Bluetooth could not be recovered with the current browser device. Press the micro:bit reset button once, then press Connect. The selected program remains prepared for recovery.', 'warn');
  } finally {`;

  const androidAwareDirectRecoveryCatch = `  } catch (error) {
    pendingDfu = recoveryPackage;
    dfuChooserReady = false;
    try { bootloaderDevice?.gatt?.disconnect?.(); } catch {}
    applicationDevice = null;
    partialCharacteristic = null;
    buttonlessAvailable = false;
    secureDfuAvailable = false;

    if (error?.code === '${ANDROID_DFU_AUTHORIZATION_REQUIRED}') {
      androidAuthorizationRefreshRequired = true;
      recoveryReconnectPending = true;
      recoveryConnectFailures = 0;
      setState('connectionState', 'Power cycle needed', 'warn');
      setState('modeState', 'Refresh Bluetooth pairing', 'warn');
      setState('methodState', 'Android recovery', 'warn');
      el('progressText').textContent = 'Power the micro:bit off and on, enter pairing mode if needed, then Connect';
      log(error.message, 'error');
      log('${ANDROID_DFU_AUTHORIZATION_REQUIRED}: Android Chrome can see the Secure DFU bootloader, but protected DFU responses are not authorized in this recovery connection.', 'warn');
      log('Do not reconnect to recovery mode again. Power the micro:bit off and on, enter Bluetooth pairing mode if needed, then press Connect. The pending program will stay prepared but will not auto-resume until the normal application is detected.', 'warn');
      return;
    }

    recoveryReconnectPending = true;
    setState('connectionState', 'Reconnect', 'warn');
    setState('modeState', 'Recovery', 'warn');
    setState('methodState', 'Waiting to reconnect', 'warn');
    el('progressText').textContent = 'Programming was interrupted — press reset once, then Connect';
    log(error.message, 'error');
    log('Bluetooth could not be recovered with the current browser device. Press the micro:bit reset button once, then press Connect. The selected program remains prepared for recovery.', 'warn');
  } finally {`;

  patched = replaceOnce(
    patched,
    directRecoveryCatch,
    androidAwareDirectRecoveryCatch,
    'Android direct recovery authorization handling',
  );

  // The browser-required second selection has a separate catch. Route the
  // Android authorization failure into the same power-cycle gate there too.
  patched = replaceOnce(
    patched,
    `    if (error?.code === 'DFU_CANDIDATE_APPLICATION') {`,
    `    if (error?.code === '${ANDROID_DFU_AUTHORIZATION_REQUIRED}') {
      pendingDfu = packageToFlash;
      dfuChooserReady = false;
      androidAuthorizationRefreshRequired = true;
      recoveryReconnectPending = true;
      recoveryConnectFailures = 0;
      try { bootloaderDevice?.gatt?.disconnect?.(); } catch {}
      applicationDevice = null;
      partialCharacteristic = null;
      buttonlessAvailable = false;
      secureDfuAvailable = false;
      setState('connectionState', 'Power cycle needed', 'warn');
      setState('modeState', 'Refresh Bluetooth pairing', 'warn');
      setState('methodState', 'Android recovery', 'warn');
      el('progressText').textContent = 'Power the micro:bit off and on, enter pairing mode if needed, then Connect';
      log('Android Secure DFU authorization was not restored after the second Bluetooth selection. Power the micro:bit off and on; the pending program is preserved and will not auto-resume until normal application services are detected.', 'warn');
    } else if (error?.code === 'DFU_CANDIDATE_APPLICATION') {`,
    'Android second-selection authorization handling',
  );

  const genericProgramCatch = `  } catch (error) {
    log(error.message, 'error');
    el('progressText').textContent = 'Stopped: ' + error.message;
  } finally {`;

  const compatibilityAwareCatch = `  } catch (error) {
    if (error?.code === '${ANDROID_DFU_AUTHORIZATION_REQUIRED}') {
      androidAuthorizationRefreshRequired = true;
      log(error.message, 'error');
      log('${ANDROID_DFU_AUTHORIZATION_REQUIRED}: Android Chrome can see the Secure DFU service, but the protected control notifications are not authorized in the current recovery connection.', 'warn');
      log('Power the micro:bit off and on. Enter Bluetooth pairing mode if needed, pair it if Android asks, then press Connect. The app must see the normal application before full wireless programming is tried again.', 'warn');
      setState('connectionState', 'Power cycle needed', 'warn');
      setState('modeState', 'Refresh Bluetooth pairing', 'warn');
      setState('methodState', 'Android recovery', 'warn');
      el('progressText').textContent = 'Power the micro:bit off and on, enter pairing mode if needed, then Connect';
      recoveryReconnectPending = true;
      recoveryConnectFailures = 0;
      return;
    }

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
      androidAuthorizationRefreshRequired = false;
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

  // A new file or explicit disconnect starts a clean workflow.
  patched = patched.replaceAll(
    'recoveryConnectFailures = 0;\n  partialRetryUsed = false;',
    'recoveryConnectFailures = 0;\n  androidAuthorizationRefreshRequired = false;\n  partialRetryUsed = false;',
  );

  if (!patched.includes(`compatibilityError.code = '${BONDED_DFU_ACCESS_UNAVAILABLE}'`)) {
    throw new Error('Terminal bonded DFU access error was not classified');
  }
  if (!patched.includes('let androidAuthorizationRefreshRequired = false;')) {
    throw new Error('Android authorization refresh state was not installed');
  }
  if (!patched.includes('Recovery mode was detected again, so the pending program will NOT auto-resume')) {
    throw new Error('Android recovery auto-resume gate was not installed');
  }
  if (!patched.includes('Power the micro:bit off and on')) {
    throw new Error('Android power-cycle guidance was not installed');
  }
  if (!patched.includes('USB setup required once')) {
    throw new Error('USB provisioning guidance was not installed');
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
