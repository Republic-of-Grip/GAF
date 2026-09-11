import { extensionsPageUrl, EXTENSIONS_RELOAD_HINT, MANUAL_APPLY_HINT } from '../core/updates.mjs';
import {
  applyUnpackedUpdate,
  CANCELLED,
  createHandleStore,
  fileSystemAccessAvailable,
  isTrustedGafZipUrl,
  NEED_DIRECTORY,
  PICK_FOLDER_HINT,
} from '../core/apply-update.mjs';

const params = new URLSearchParams(location.search);
const zipUrl = params.get('zip') || '';
const version = params.get('version') || '';
const installed = params.get('installed') || '';

const handleStore = createHandleStore();
const $ = (id) => document.getElementById(id);

function setStatus(text) {
  const el = $('status');
  if (el) el.textContent = text;
}

function pickGafDirectory() {
  return globalThis.showDirectoryPicker({
    id: 'gaf-unpacked-install',
    mode: 'readwrite',
  });
}

function extensionsUrl() {
  return extensionsPageUrl(navigator.userAgent || '');
}

async function openExtensionsPage() {
  await chrome.tabs.create({ url: extensionsUrl() });
}

function showReadyForReload() {
  const installBtn = $('install');
  const openBtn = $('openExtensions');
  if (installBtn) installBtn.hidden = true;
  if (openBtn) {
    openBtn.hidden = false;
    openBtn.focus();
  }
  setStatus(EXTENSIONS_RELOAD_HINT);
}

async function openZipFallback() {
  if (zipUrl) await chrome.tabs.create({ url: zipUrl });
  await openExtensionsPage();
  setStatus(MANUAL_APPLY_HINT);
}

async function install({ allowPicker }) {
  const installBtn = $('install');
  if (installBtn) installBtn.disabled = true;
  setStatus(version ? `Downloading GAF ${version}…` : 'Downloading GAF…');
  try {
    const result = await applyUnpackedUpdate({
      zipUrl,
      expectedVersion: version,
      handleStore,
      pickDirectory: allowPicker ? pickGafDirectory : undefined,
      afterApply: async () => {
        showReadyForReload();
        await openExtensionsPage();
      },
    });
    showReadyForReload();
    return result;
  } catch (err) {
    if (installBtn) installBtn.disabled = false;
    if (err?.code === NEED_DIRECTORY) {
      setStatus(PICK_FOLDER_HINT);
      return err;
    }
    if (err?.code === CANCELLED || err?.name === 'AbortError') {
      setStatus('Folder selection was cancelled. Nothing was downloaded.');
      return err;
    }
    setStatus(err?.message || String(err));
    return err;
  }
}

function showManualFallback(message) {
  setStatus(message || MANUAL_APPLY_HINT);
}

async function init() {
  const fromTo = $('fromTo');
  if (fromTo) {
    fromTo.textContent =
      installed && version ? `${installed} → ${version}` : version ? `Version ${version}` : '';
  }

  $('fallbackDownload')?.addEventListener('click', () => {
    openZipFallback().catch((err) => setStatus(err?.message || String(err)));
  });
  $('openExtensions')?.addEventListener('click', () => {
    openExtensionsPage().catch((err) => setStatus(err?.message || String(err)));
  });
  $('install')?.addEventListener('click', () => {
    install({ allowPicker: true }).catch((err) => setStatus(err?.message || String(err)));
  });

  if (!isTrustedGafZipUrl(zipUrl)) {
    showManualFallback(
      zipUrl
        ? 'This download only accepts the official GAF GitHub ZIP.'
        : 'Missing update ZIP. Use Check for updates, then Update.'
    );
    return;
  }

  if (!fileSystemAccessAvailable()) {
    showManualFallback(MANUAL_APPLY_HINT);
    await openZipFallback();
    return;
  }

  const err = await install({ allowPicker: false });
  if (err?.code === NEED_DIRECTORY) {
    setStatus(
      version
        ? `Download GAF ${version} into the folder Helium is already using. You pick that folder once so later updates can land there. Then Reload on Extensions — do not Load unpacked again.`
        : PICK_FOLDER_HINT
    );
  }
}

init().catch((err) => {
  setStatus(err?.message || String(err));
});
