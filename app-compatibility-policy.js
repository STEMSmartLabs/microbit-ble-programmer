import { patchAppSourceForResetRecovery } from './app-recovery-policy.js?v=2.4.17';

const DEFAULT_VERSION = '2.4.17';
const BONDED_DFU_ACCESS_UNAVAILABLE = 'BONDED_DFU_ACCESS_UNAVAILABLE';
const ANDROID_DFU_AUTHORIZATION_REQUIRED = 'ANDROID_DFU_AUTHORIZATION_REQUIRED';
const ANDROID_DFU_TRANSITION_STALE = 'ANDROID_DFU_TRANSITION_STALE';

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

  // After one physical power cycle, a single Connect owns the Android cache
  // refresh. If Chrome still exposes the old Secure DFU table, leave GATT quiet
  // for long intervals and rediscover services. Do not ask for repeated power
  // cycles; only normal application services clear the authorization gate.
  patched = replaceOnce(
    patched,
    `      if (pendingDfu) {
        recoveryReconnectPending = false;`,
    `      if (androidAuthorizationRefreshRequired) {
        recoveryReconnectPending = true;
        dfuChooserReady = false;
        setState('connectionState', 'Refreshing Bluetooth…', 'busy');
        setState('modeState', 'Waiting for application', 'warn');
        setState('methodState', 'Android recovery', 'warn');
        el('progressText').textContent = 'Waiting for Android Bluetooth to refresh after the power cycle…';
        log('Android still exposes the previous Secure DFU services after the power cycle. The app will leave GATT quiet and recheck automatically; do not power-cycle again.', 'warn');

        const androidRefreshDelays = [10000, 15000, 20000];
        let refreshedToApplication = false;
        for (let refreshAttempt = 0; refreshAttempt < androidRefreshDelays.length; refreshAttempt++) {
          const refreshDelay = androidRefreshDelays[refreshAttempt];
          try { selectedDevice.gatt?.disconnect?.(); } catch {}
          partialCharacteristic = null;
          buttonlessAvailable = false;
          secureDfuAvailable = false;
          setState('connectionState', 'Refreshing Bluetooth…', 'busy');
          el('progressText').textContent = 'Waiting for Android Bluetooth to refresh…';
          log('Leaving Android GATT quiet for ' + Math.round(refreshDelay / 1000) + ' seconds before application-service check ' + (refreshAttempt + 1) + '/' + androidRefreshDelays.length + '.');
          await sleep(refreshDelay);

          try {
            const refreshed = await attachApplicationServices();
            await sleep(700);
            if (selectedDevice.gatt.connected && refreshed?.mode === 'application') {
              classification = refreshed;
              refreshedToApplication = true;
              break;
            }
          } catch (refreshError) {
            log('Android Bluetooth refresh check did not expose the normal application yet: ' + refreshError.message, 'warn');
          }
        }

        if (refreshedToApplication) {
          androidAuthorizationRefreshRequired = false;
          recoveryConnectFailures = 0;
          pendingDfu = null;
          dfuChooserReady = false;
          recoveryReconnectPending = false;
          setState('connectionState', selectedDevice.name || 'micro:bit', 'good');
          setState('modeState', 'Ready', 'good');
          setState('runtimeState', 'Not checked', 'neutral');
          setState('methodState', 'Automatic', 'neutral');
          el('progressText').textContent = preparedFirmware
            ? 'Bluetooth refreshed — press Program'
            : 'Bluetooth refreshed — choose a HEX file';
          log('Normal application services are visible again after one power cycle and a quiet Android Bluetooth refresh. Normal programming can continue.', 'good');
          log('Services: '
            + (partialCharacteristic ? 'partial programming' : '')
            + (partialCharacteristic && buttonlessAvailable ? ' + ' : '')
            + (buttonlessAvailable ? 'full programming' : '')
            + '.');
          return;
        }

        try { selectedDevice.gatt?.disconnect?.(); } catch {}
        applicationDevice = null;
        partialCharacteristic = null;
        buttonlessAvailable = false;
        secureDfuAvailable = false;
        setState('connectionState', 'Refresh pending', 'warn');
        setState('modeState', 'Waiting for application', 'warn');
        setState('methodState', 'Android recovery', 'warn');
        el('progressText').textContent = 'Android Bluetooth is still refreshing — wait briefly, then press Connect once';
        log('Android still shows the previous recovery services after the quiet refresh window. Do not power-cycle again. Wait briefly, then press Connect once to request a fresh browser Bluetooth view.', 'warn');
        return;
      }

      if (pendingDfu) {
        recoveryReconnectPending = false;`,
    'quiet Android authorization refresh after one power cycle',
  );

  // If application services are already fresh on the first post-power-cycle
  // Connect, clear the gate immediately and continue through normal programming.
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
    'clear Android authorization gate in application mode',
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
      setState('connectionState', 'Power cycle once', 'warn');
      setState('modeState', 'Refresh Bluetooth pairing', 'warn');
      setState('methodState', 'Android recovery', 'warn');
      el('progressText').textContent = 'Power the micro:bit off and on once, then Connect';
      log(error.message, 'error');
      log('${ANDROID_DFU_AUTHORIZATION_REQUIRED}: Android Chrome can see the Secure DFU bootloader, but protected DFU responses are not authorized in this recovery connection.', 'warn');
      log('Power the micro:bit off and on once, enter Bluetooth pairing mode if needed, then press Connect. After that one power cycle the app will wait for Android Bluetooth to refresh automatically; do not repeat the power cycle.', 'warn');
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

  // The browser-required second selection has a separate catch. Authorization
  // failure enters the same one-power-cycle gate. A stale application table
  // after the quiet post-opcode window preserves the package and asks for one
  // fresh Connect instead of claiming the application is really running.
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
      setState('connectionState', 'Power cycle once', 'warn');
      setState('modeState', 'Refresh Bluetooth pairing', 'warn');
      setState('methodState', 'Android recovery', 'warn');
      el('progressText').textContent = 'Power the micro:bit off and on once, then Connect';
      log('Android Secure DFU authorization was not restored after the second Bluetooth selection. Power the micro:bit off and on once; the pending program is preserved. After Connect, the app will wait quietly for Android Bluetooth to refresh.', 'warn');
    } else if (error?.code === '${ANDROID_DFU_TRANSITION_STALE}') {
      pendingDfu = packageToFlash;
      dfuChooserReady = false;
      recoveryReconnectPending = true;
      try { bootloaderDevice?.gatt?.disconnect?.(); } catch {}
      applicationDevice = null;
      partialCharacteristic = null;
      buttonlessAvailable = false;
      secureDfuAvailable = false;
      setState('connectionState', 'Refresh Bluetooth', 'warn');
      setState('modeState', 'Waiting for programming mode', 'warn');
      setState('methodState', 'Android transition', 'warn');
      el('progressText').textContent = 'Android is still showing old Bluetooth services — press Connect once';
      log('The DFU reboot was already confirmed, but Android still exposes the previous application services after the quiet refresh window. Press Connect once to request a fresh Bluetooth view; the prepared program is preserved.', 'warn');
    } else if (error?.code === 'DFU_CANDIDATE_APPLICATION') {`,
    'Android second-selection authorization and stale-service handling',
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
      log('Power the micro:bit off and on once. Enter Bluetooth pairing mode if needed, pair it if Android asks, then press Connect. After that one power cycle the app will handle the Android Bluetooth refresh; do not repeat the power cycle.', 'warn');
      setState('connectionState', 'Power cycle once', 'warn');
      setState('modeState', 'Refresh Bluetooth pairing', 'warn');
      setState('methodState', 'Android recovery', 'warn');
      el('progressText').textContent = 'Power the micro:bit off and on once, then Connect';
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
  if (!patched.includes('androidRefreshDelays = [10000, 15000, 20000]')) {
    throw new Error('Android quiet authorization refresh window was not installed');
  }
  if (!patched.includes('do not power-cycle again')) {
    throw new Error('Single power-cycle Android guidance was not installed');
  }
  if (!patched.includes(ANDROID_DFU_TRANSITION_STALE)) {
    throw new Error('Android stale transition handling was not installed');
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
