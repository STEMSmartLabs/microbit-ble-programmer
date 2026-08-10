import { patchAppSourceForBondedDfuCompatibility } from './app-compatibility-policy.js?v=2.4.19';

const DEFAULT_VERSION = '2.4.19';
const ANDROID_DFU_TRANSITION_STALE = 'ANDROID_DFU_TRANSITION_STALE';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Could not patch ${label}: expected source was not found`);
  }
  return source.replace(before, after);
}

export function patchAppSourceForConfirmedDfuHandoff(source, {
  baseUrl,
  version = DEFAULT_VERSION,
} = {}) {
  let patched = patchAppSourceForBondedDfuCompatibility(source, { baseUrl, version });

  patched = replaceOnce(
    patched,
    'let androidAuthorizationRefreshRequired = false;',
    'let androidAuthorizationRefreshRequired = false;\nlet androidDfuRebootConfirmed = false;',
    'Android confirmed DFU reboot state',
  );

  // Positive opcode/write acknowledgement is the authority that the application
  // has been asked to reboot. On Android, retain that fact across stale GATT
  // tables until either true Secure DFU (0001+0002) or a complete application
  // view (Partial Programming + buttonless 0004) is verified.
  patched = replaceOnce(
    patched,
    `  if (entryResult === 'confirmed') {
    markDfuChooserReady();`,
    `  if (entryResult === 'confirmed') {
    androidDfuRebootConfirmed = /Android/i.test(String(navigator.userAgent || ''));
    markDfuChooserReady();`,
    'confirmed Android DFU reboot latch',
  );

  // The Android authorization-refresh quiet loop must not accept an incomplete
  // 0004-only application table as proof that the application really returned.
  patched = replaceOnce(
    patched,
    `            if (selectedDevice.gatt.connected && refreshed?.mode === 'application') {`,
    `            if (selectedDevice.gatt.connected
              && refreshed?.mode === 'application'
              && partialCharacteristic
              && buttonlessAvailable) {`,
    'complete application verification during Android authorization refresh',
  );

  // Genuine Secure DFU is authoritative. Clear the transition latch before any
  // direct recovery so a later authorization failure can use its own power-cycle
  // recovery state without also looking like an unfinished reboot transition.
  patched = replaceOnce(
    patched,
    `    if (classification.mode === 'secure-dfu') {
      recoveryConnectFailures = 0;`,
    `    if (classification.mode === 'secure-dfu') {
      recoveryConnectFailures = 0;
      if (androidDfuRebootConfirmed) {
        androidDfuRebootConfirmed = false;
        log('Secure DFU control 0001 and packet 0002 are now visible after the confirmed reboot. Clearing the Android stale-transition latch.');
      }`,
    'clear confirmed reboot latch on genuine Secure DFU',
  );

  // After a confirmed Android DFU reboot, an application-class result is
  // trusted only when BOTH the Partial Programming service and buttonless 0004
  // are visible. 0004-only is the stale Android GATT pattern seen while the
  // physical micro:bit is already showing the DFU plus.
  patched = replaceOnce(
    patched,
    `    } else {
      recoveryConnectFailures = 0;
      if (androidAuthorizationRefreshRequired) {`,
    `    } else {
      recoveryConnectFailures = 0;
      const androidCompleteApplicationView = Boolean(partialCharacteristic && buttonlessAvailable);
      if ((androidDfuRebootConfirmed || androidAuthorizationRefreshRequired)
          && !androidCompleteApplicationView) {
        const waitingForConfirmedDfu = androidDfuRebootConfirmed;
        recoveryReconnectPending = true;
        dfuChooserReady = false;
        try { selectedDevice.gatt?.disconnect?.(); } catch {}
        applicationDevice = null;
        partialCharacteristic = null;
        buttonlessAvailable = false;
        secureDfuAvailable = false;
        setState('connectionState', 'Refresh Bluetooth', 'warn');
        setState('modeState', waitingForConfirmedDfu ? 'Waiting for programming mode' : 'Waiting for application', 'warn');
        setState('methodState', 'Android Bluetooth refresh', 'warn');
        el('progressText').textContent = waitingForConfirmedDfu
          ? 'DFU reboot is confirmed — Android still shows old services. Press Connect once'
          : 'Android Bluetooth is still refreshing after the power cycle — press Connect once';
        log(waitingForConfirmedDfu
          ? 'The DFU reboot is already confirmed. Android currently exposes only an incomplete/stale application service view, so the pending program is preserved and Buttonless DFU 0004 will NOT be used again. Press Connect once to refresh the browser Bluetooth view.'
          : 'Android authorization refresh is still pending and the application service view is incomplete. Do not power-cycle again. Press Connect once to refresh the browser Bluetooth view.', 'warn');
        return;
      }

      if (androidDfuRebootConfirmed) {
        androidDfuRebootConfirmed = false;
        log('A complete application service view (Partial Programming + full programming) is visible after the confirmed DFU reboot. Treating the application as genuinely returned.', 'warn');
      }
      if (androidAuthorizationRefreshRequired) {`,
    'reject stale 0004-only Android application view after confirmed reboot',
  );

  // If the quiet post-opcode transition window expires, keep the confirmed
  // reboot state explicit while the package is preserved for the next Connect.
  patched = replaceOnce(
    patched,
    `    } else if (error?.code === '${ANDROID_DFU_TRANSITION_STALE}') {
      pendingDfu = packageToFlash;`,
    `    } else if (error?.code === '${ANDROID_DFU_TRANSITION_STALE}') {
      androidDfuRebootConfirmed = true;
      pendingDfu = packageToFlash;`,
    'preserve confirmed reboot state after stale Android transition',
  );

  // Successful full programming ends the handoff state. There are two success
  // paths (fresh second selection and direct recovery), both use this log text.
  patched = patched.replaceAll(
    `    log('Full application programming complete.');
    pendingDfu = null;`,
    `    log('Full application programming complete.');
    androidDfuRebootConfirmed = false;
    pendingDfu = null;`,
  );

  // Explicit user actions start a clean handoff state.
  patched = replaceOnce(
    patched,
    `async function loadHexFile(file) {
  if (!file) return;
  selectedFileName = file.name;`,
    `async function loadHexFile(file) {
  if (!file) return;
  selectedFileName = file.name;
  androidDfuRebootConfirmed = false;`,
    'clear confirmed reboot state on new HEX',
  );
  patched = replaceOnce(
    patched,
    `function cancelPendingDfu() {
  if (flashInProgress) return;`,
    `function cancelPendingDfu() {
  if (flashInProgress) return;
  androidDfuRebootConfirmed = false;`,
    'clear confirmed reboot state on cancel',
  );
  patched = replaceOnce(
    patched,
    `function disconnectApplication() {
  if (flashInProgress) return log('Cannot disconnect while programming is in progress.', 'warn');`,
    `function disconnectApplication() {
  if (flashInProgress) return log('Cannot disconnect while programming is in progress.', 'warn');
  androidDfuRebootConfirmed = false;`,
    'clear confirmed reboot state on disconnect',
  );

  if (!patched.includes('let androidDfuRebootConfirmed = false;')) {
    throw new Error('Android confirmed DFU reboot state was not installed');
  }
  if (!patched.includes("androidDfuRebootConfirmed = /Android/i.test")) {
    throw new Error('Confirmed Android reboot latch was not wired to positive DFU entry');
  }
  if (!patched.includes('androidCompleteApplicationView = Boolean(partialCharacteristic && buttonlessAvailable)')) {
    throw new Error('Complete Android application-view verification was not installed');
  }
  if (!patched.includes('Buttonless DFU 0004 will NOT be used again')) {
    throw new Error('Stale 0004-only Android protection was not installed');
  }
  if (!patched.includes('Secure DFU control 0001 and packet 0002 are now visible')) {
    throw new Error('Secure DFU transition completion was not installed');
  }

  return patched;
}

export async function loadConfirmedDfuHandoffApp({
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
    throw new Error(`Could not load app.js for confirmed DFU handoff policy (${response.status})`);
  }

  const originalSource = await response.text();
  const patchedSource = patchAppSourceForConfirmedDfuHandoff(originalSource, {
    baseUrl: moduleBaseUrl,
    version,
  });
  const sourceWithLabel = patchedSource
    + '\n//# sourceURL=' + appUrl.href
    + '&confirmed-dfu-handoff=' + version + '\n';
  const blobUrl = URL.createObjectURL(new Blob([sourceWithLabel], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
