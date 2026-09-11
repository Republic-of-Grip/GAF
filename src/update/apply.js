import { extensionsPageUrl, MANUAL_APPLY_HINT } from '../core/updates.mjs';
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

async function openFallback() {
  if (zipUrl) await chrome.tabs.create({ url: zipUrl });
  await chrome.tabs.create({ url: extensionsPageUrl(navigator.userAgent || '') });
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
      reload: async () => {
        setStatus(`Installed ${version || 'the update'}. Reloading GAF…`);
        chrome.runtime.reload();
      },
    });
    setStatus(`Installed ${result.version}. Reloading GAF…`);
  } catch (err) {
    if (installBtn) installBtn.disabled = false;
    if (err?.code === NEED_DIRECTORY) {
      setStatus(PICK_FOLDER_HINT);
      return err;
    }
    if (err?.code === CANCELLED || err?.name === 'AbortError') {
      setStatus('Folder selection was cancelled. Nothing was installed.');
      return err;
    }
    setStatus(err?.message || String(err));
    return err;
  }
  return null;
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
    openFallback().catch((err) => setStatus(err?.message || String(err)));
  });
  $('install')?.addEventListener('click', () => {
    install({ allowPicker: true }).catch((err) => setStatus(err?.message || String(err)));
  });

  if (!isTrustedGafZipUrl(zipUrl)) {
    showManualFallback(
      zipUrl
        ? 'This installer only accepts the official GAF GitHub ZIP.'
        : 'Missing update ZIP. Use Check for updates, then Install update.'
    );
    return;
  }

  if (!fileSystemAccessAvailable()) {
    showManualFallback(MANUAL_APPLY_HINT);
    return;
  }

  const err = await install({ allowPicker: false });
  if (err?.code === NEED_DIRECTORY) {
    setStatus(
      version
        ? `Install GAF ${version} into the unpacked folder Helium is using. You pick that folder once; later updates can reuse it.`
        : PICK_FOLDER_HINT
    );
  }
}

init().catch((err) => {
  setStatus(err?.message || String(err));
});
