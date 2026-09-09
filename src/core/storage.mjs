/**
 * Storage helpers for settings, exclusions, archive.
 *
 * Settings use **local-first** storage. Helium / some Chromium builds accept
 * chrome.storage.sync.set without reliably persisting it for unpacked extensions,
 * so a popup toggle appeared to "do nothing" (slider snapped back to OFF).
 *
 * Write: local (required) + sync (best-effort mirror for browsers that sync).
 * Read: local if present, else sync (and migrate into local).
 */

import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  EXCLUSIONS_KEY,
  ARCHIVE_KEY,
  normalizeSettings,
} from './settings.mjs';
import {
  normalizeExclusions,
  migrateAllowHostsToExclusions,
  activeExclusionHosts,
} from './exclusions.mjs';
import { normalizeArchive, prependArchive } from './archive.mjs';

function hasOwnSettings(obj) {
  return obj && typeof obj === 'object' && Object.keys(obj).length > 0;
}

/**
 * Pure local-first precedence (local authoritative, sync secondary).
 * Used by loadSettings and regression tests so every layer shares one rule.
 *
 * @param {unknown} localSettings
 * @param {unknown} syncSettings
 * @returns {{ settings: object, source: 'local' | 'sync' | 'default' }}
 */
export function resolveAuthoritativeSettings(localSettings, syncSettings) {
  if (hasOwnSettings(localSettings)) {
    return { settings: normalizeSettings(localSettings), source: 'local' };
  }
  if (hasOwnSettings(syncSettings)) {
    return { settings: normalizeSettings(syncSettings), source: 'sync' };
  }
  return { settings: normalizeSettings(DEFAULT_SETTINGS), source: 'default' };
}

/**
 * Load settings: prefer local, fall back to sync, migrate sync → local once.
 */
export async function loadSettings() {
  let localVal = null;
  let syncVal = null;

  try {
    const local = await chrome.storage.local.get({ [STORAGE_KEY]: null });
    localVal = local[STORAGE_KEY];
  } catch {
    /* continue */
  }

  try {
    const sync = await chrome.storage.sync.get({ [STORAGE_KEY]: null });
    syncVal = sync[STORAGE_KEY];
  } catch {
    /* ignore */
  }

  const { settings, source } = resolveAuthoritativeSettings(localVal, syncVal);

  // Migrate sync → local once so Helium/popup saves stick
  if (source === 'sync') {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    } catch {
      /* ignore migrate failure */
    }
  }

  return settings;
}

/**
 * Save settings to local (source of truth) and mirror to sync when possible.
 */
export async function saveSettings(partialOrFull) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...partialOrFull });

  // Local is authoritative
  await chrome.storage.local.set({ [STORAGE_KEY]: next });

  // Best-effort sync mirror (may no-op or fail on Helium)
  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  } catch {
    /* ignore */
  }

  return next;
}

export async function resetSettings() {
  const next = normalizeSettings(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * Verify a save stuck (for popup feedback).
 */
export async function verifySettingsEnabled() {
  const s = await loadSettings();
  return Boolean(s.enabled);
}

export async function loadExclusions() {
  const data = await chrome.storage.local.get({ [EXCLUSIONS_KEY]: [] });
  let list = normalizeExclusions(data[EXCLUSIONS_KEY]);

  // One-time migration from legacy allowHosts in settings
  try {
    const settings = await loadSettings();
    if (settings.allowHosts?.length) {
      const merged = migrateAllowHostsToExclusions(settings.allowHosts, list);
      if (merged.length !== list.length) {
        list = merged;
        await chrome.storage.local.set({ [EXCLUSIONS_KEY]: list });
        await saveSettings({ allowHosts: [] });
      }
    }
  } catch {
    /* ignore */
  }

  return list;
}

export async function saveExclusions(list) {
  const next = normalizeExclusions(list);
  await chrome.storage.local.set({ [EXCLUSIONS_KEY]: next });
  return next;
}

export async function loadArchive() {
  const data = await chrome.storage.local.get({ [ARCHIVE_KEY]: [] });
  return normalizeArchive(data[ARCHIVE_KEY]);
}

export async function saveArchive(list) {
  const next = normalizeArchive(list);
  await chrome.storage.local.set({ [ARCHIVE_KEY]: next });
  return next;
}

export async function addArchiveEntry(entry) {
  const list = await loadArchive();
  const next = prependArchive(list, entry);
  await chrome.storage.local.set({ [ARCHIVE_KEY]: next });
  return next;
}

export async function getActiveExclusionHosts() {
  const list = await loadExclusions();
  return activeExclusionHosts(list);
}

export function onSettingsChanged(callback) {
  const handler = (changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      callback({ type: 'settings', value: normalizeSettings(changes[STORAGE_KEY].newValue) });
    }
    if (changes[EXCLUSIONS_KEY]) {
      callback({ type: 'exclusions', value: normalizeExclusions(changes[EXCLUSIONS_KEY].newValue) });
    }
    if (changes[ARCHIVE_KEY]) {
      callback({ type: 'archive', value: normalizeArchive(changes[ARCHIVE_KEY].newValue) });
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
