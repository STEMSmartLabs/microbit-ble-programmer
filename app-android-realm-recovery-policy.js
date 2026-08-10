import { patchAppSourceForConfirmedDfuHandoff } from './app-confirmed-dfu-policy.js?v=2.4.20';

const DEFAULT_VERSION = '2.4.20';
const ANDROID_DFU_TRANSITION_STALE = 'ANDROID_DFU_TRANSITION_STALE';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Could not patch ${label}: expected source was not found`);
  }
  return source.replace(before, after);
}

export function patchAppSourceForAndroidRealmRecovery(source, {
  baseUrl,
  version = DEFAULT_VERSION,
} = {}) {
  let patched = patchAppSourceForConfirmedDfuHandoff(source, { baseUrl, version });

  patched = replaceOnce(
    patched,
    'let androidDfuRebootConfirmed = false;',
    `let androidDfuRebootConfirmed = false;
let androidDfuRealmRefreshUsed = false;
const ANDROID_DFU_REALM_RECOVERY_KEY = 'stem.microbit.androidDfuRealmRecovery.v1';

function bytesToSessionBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function sessionBase64ToBytes(text) {
  const binary = atob(String(text || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function persistAndroidDfuRealmRecovery(packageToFlash) {
  if (!packageToFlash?.firmware || !packageToFlash?.initPacket) {
    throw new Error('The pending DFU package is incomplete and cannot be preserved across the Android Bluetooth refresh');
  }
  sessionStorage.setItem(ANDROID_DFU_REALM_RECOVERY_KEY, JSON.stringify({
    version: APP_VERSION,
    fileName: packageToFlash.fileName || selectedFileName || 'micro:bit program',
    applicationStart: Number(packageToFlash.applicationStart) || 0,
    entryConfidence: packageToFlash.entryConfidence || 'confirmed',
    initPacket: bytesToSessionBase64(packageToFlash.initPacket),
    firmware: bytesToSessionBase64(packageToFlash.firmware),
  }));
}

function restoreAndroidDfuRealmRecovery() {
  const raw = sessionStorage.getItem(ANDROID_DFU_REALM_RECOVERY_KEY);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload?.firmware || !payload?.initPacket) throw new Error('saved package is incomplete');
    return {
      initPacket: sessionBase64ToBytes(payload.initPacket),
      firmware: sessionBase64ToBytes(payload.firmware),
      applicationStart: Number(payload.applicationStart) || 0,
      fileName: payload.fileName || 'micro:bit program',
      entryConfidence: payload.entryConfidence || 'confirmed',
    };
  } catch (error) {
    sessionStorage.removeItem(ANDROID_DFU_REALM_RECOVERY_KEY);
    console.warn('Could not restore Android DFU page-refresh package', error);
    return null;
  }
}

function clearAndroidDfuRealmRecovery() {
  try { sessionStorage.removeItem(ANDROID_DFU_REALM_RECOVERY_KEY); } catch {}
}`,
    'Android page-refresh storage helpers',
  );

  const currentStaleBranch = `    } else if (error?.code === '${ANDROID_DFU_TRANSITION_STALE}') {
      androidDfuRebootConfirmed = true;
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
      log('The DFU reboot was already confirmed, but Android still exposes the previous application services after the quiet refresh window. Press Connect once to request a fresh Bluetooth view; the prepared program is preserved.', 'warn');`;

  const realmRefreshBranch = `    } else if (error?.code === '${ANDROID_DFU_TRANSITION_STALE}') {
      androidDfuRebootConfirmed = true;
      pendingDfu = packageToFlash;
      dfuChooserReady = false;
      recoveryReconnectPending = true;
      try { bootloaderDevice?.gatt?.disconnect?.(); } catch {}

      if (/Android/i.test(String(navigator.userAgent || '')) && !androidDfuRealmRefreshUsed) {
        androidDfuRealmRefreshUsed = true;
        try {
          persistAndroidDfuRealmRecovery(packageToFlash);
          applicationDevice = null;
          partialCharacteristic = null;
          buttonlessAvailable = false;
          secureDfuAvailable = false;
          setState('connectionState', 'Refreshing Bluetooth', 'busy');
          setState('modeState', 'Programming mode confirmed', 'busy');
          setState('methodState', 'Android Bluetooth refresh', 'busy');
          el('progressText').textContent = 'Refreshing Android Bluetooth once — prepared program is preserved';
          log('The normal Android DFU transition checks were exhausted while the DFU reboot is already confirmed. Preserving the prepared program and reloading the page once to create a fresh Web Bluetooth context. Existing successful DFU paths are unchanged.', 'warn');
          setTimeout(() => location.reload(), 150);
          return;
        } catch (persistError) {
          log('Could not preserve the pending program for the one-time Android page refresh: ' + persistError.message + '. Falling back to the normal Connect recovery path.', 'warn');
        }
      }

      applicationDevice = null;
      partialCharacteristic = null;
      buttonlessAvailable = false;
      secureDfuAvailable = false;
      setState('connectionState', 'Refresh Bluetooth', 'warn');
      setState('modeState', 'Waiting for programming mode', 'warn');
      setState('methodState', 'Android transition', 'warn');
      el('progressText').textContent = 'Android is still showing old Bluetooth services — press Connect once';
      log('The DFU reboot was already confirmed, but Android still exposes the previous application services. Press Connect once to request a fresh Bluetooth view; the prepared program is preserved.', 'warn');`;

  patched = replaceOnce(
    patched,
    currentStaleBranch,
    realmRefreshBranch,
    'one-time Android page refresh after exhausted confirmed-DFU transition',
  );

  patched = replaceOnce(
    patched,
    `if (!window.isSecureContext) {`,
    `const restoredAndroidDfuPackage = /Android/i.test(String(navigator.userAgent || ''))
  ? restoreAndroidDfuRealmRecovery()
  : null;
if (restoredAndroidDfuPackage) {
  pendingDfu = restoredAndroidDfuPackage;
  selectedFileName = restoredAndroidDfuPackage.fileName;
  androidDfuRebootConfirmed = true;
  androidDfuRealmRefreshUsed = true;
  recoveryReconnectPending = true;
  dfuChooserReady = false;
  applicationDevice = null;
  partialCharacteristic = null;
  buttonlessAvailable = false;
  secureDfuAvailable = false;
  setState('fileState', 'Prepared', 'good');
  el('fileName').textContent = restoredAndroidDfuPackage.fileName;
  el('fileDetails').textContent = 'Prepared full wireless update restored after Android Bluetooth refresh';
  setState('connectionState', 'Connect to continue', 'warn');
  setState('modeState', 'Programming mode expected', 'warn');
  setState('runtimeState', 'Not required', 'neutral');
  setState('methodState', 'Resume full programming', 'warn');
  resetProgress(restoredAndroidDfuPackage.firmware.length, 'Android Bluetooth refreshed — press Connect once');
  log('Restored the pending full-programming package after the one-time Android page refresh. Press Connect once and select the micro:bit; if Secure DFU 0001+0002 is visible, programming will continue automatically.', 'warn');
}

if (!window.isSecureContext) {`,
    'restore pending Android DFU package after page refresh',
  );

  patched = patched.replaceAll(
    `    androidDfuRebootConfirmed = false;
    pendingDfu = null;`,
    `    androidDfuRebootConfirmed = false;
    clearAndroidDfuRealmRecovery();
    pendingDfu = null;`,
  );

  patched = replaceOnce(
    patched,
    `async function loadHexFile(file) {
  if (!file) return;
  selectedFileName = file.name;`,
    `async function loadHexFile(file) {
  if (!file) return;
  clearAndroidDfuRealmRecovery();
  androidDfuRealmRefreshUsed = false;
  selectedFileName = file.name;`,
    'clear Android page-refresh state on new HEX',
  );
  patched = replaceOnce(
    patched,
    `function cancelPendingDfu() {
  if (flashInProgress) return;
  androidDfuRebootConfirmed = false;`,
    `function cancelPendingDfu() {
  if (flashInProgress) return;
  clearAndroidDfuRealmRecovery();
  androidDfuRealmRefreshUsed = false;
  androidDfuRebootConfirmed = false;`,
    'clear Android page-refresh state on cancel',
  );
  patched = replaceOnce(
    patched,
    `function disconnectApplication() {
  if (flashInProgress) return log('Cannot disconnect while programming is in progress.', 'warn');
  androidDfuRebootConfirmed = false;`,
    `function disconnectApplication() {
  if (flashInProgress) return log('Cannot disconnect while programming is in progress.', 'warn');
  clearAndroidDfuRealmRecovery();
  androidDfuRealmRefreshUsed = false;
  androidDfuRebootConfirmed = false;`,
    'clear Android page-refresh state on disconnect',
  );

  if (!patched.includes('ANDROID_DFU_REALM_RECOVERY_KEY')) {
    throw new Error('Android page-refresh storage was not installed');
  }
  if (!patched.includes('persistAndroidDfuRealmRecovery(packageToFlash)')) {
    throw new Error('Android pending DFU persistence was not installed');
  }
  if (!patched.includes('setTimeout(() => location.reload(), 150)')) {
    throw new Error('One-time Android page refresh was not installed');
  }
  if (!patched.includes('restoredAndroidDfuPackage')) {
    throw new Error('Android pending DFU restoration was not installed');
  }
  if (patched.includes('.forget()')) {
    throw new Error('v2.4.20 must not revoke the Android Bluetooth bond/permission during the page-refresh experiment');
  }

  return patched;
}

export async function loadAndroidRealmRecoveryApp({
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
    throw new Error(`Could not load app.js for Android page-refresh recovery policy (${response.status})`);
  }

  const originalSource = await response.text();
  const patchedSource = patchAppSourceForAndroidRealmRecovery(originalSource, {
    baseUrl: moduleBaseUrl,
    version,
  });
  const sourceWithLabel = patchedSource
    + '\n//# sourceURL=' + appUrl.href
    + '&android-page-refresh=' + version + '\n';
  const blobUrl = URL.createObjectURL(new Blob([sourceWithLabel], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
