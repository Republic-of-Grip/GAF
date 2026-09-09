/**
 * Site exclusion backlog.
 *
 * When a site is excluded, it is not a silent forever-allow — it is a ticket
 * for later examination ("something broke; fix GAF and re-enable filtering").
 */

import { normalizeHost } from './settings.mjs';

export const EXCLUSION_STATUSES = ['open', 'reviewing', 'resolved'];

/**
 * @typedef {object} ExclusionEntry
 * @property {string} id
 * @property {string} host
 * @property {string} [urlSample]
 * @property {string} [note]
 * @property {string} [reason]  user-facing reason (broke video, broke login, …)
 * @property {'open'|'reviewing'|'resolved'} status
 * @property {string} createdAt ISO
 * @property {string} [updatedAt] ISO
 * @property {string} [source] popup | options | import
 */

export function createExclusion({
  host,
  urlSample = '',
  note = '',
  reason = 'Site broken or misbehaved under GAF',
  status = 'open',
  source = 'popup',
} = {}) {
  const h = normalizeHost(host);
  if (!h) throw new Error('host required');
  const now = new Date().toISOString();
  return {
    id: `ex_${h}_${Date.now().toString(36)}`,
    host: h,
    urlSample: String(urlSample || ''),
    note: String(note || ''),
    reason: String(reason || ''),
    status: EXCLUSION_STATUSES.includes(status) ? status : 'open',
    createdAt: now,
    updatedAt: now,
    source: String(source || 'popup'),
  };
}

export function normalizeExclusion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const host = normalizeHost(raw.host);
  if (!host) return null;
  return {
    id: String(raw.id || `ex_${host}_${Date.now().toString(36)}`),
    host,
    urlSample: String(raw.urlSample || ''),
    note: String(raw.note || ''),
    reason: String(raw.reason || 'Excluded from filtering'),
    status: EXCLUSION_STATUSES.includes(raw.status) ? raw.status : 'open',
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    source: String(raw.source || 'unknown'),
  };
}

export function normalizeExclusions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const e = normalizeExclusion(item);
    if (!e) continue;
    // One active exclusion per host (prefer open/reviewing over resolved)
    const key = e.host;
    if (seen.has(key) && e.status === 'resolved') continue;
    if (seen.has(key)) {
      // replace if new is more open
      const idx = out.findIndex((x) => x.host === key);
      if (idx >= 0 && out[idx].status === 'resolved' && e.status !== 'resolved') {
        out[idx] = e;
      }
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Hosts that currently skip filtering (open + reviewing). Resolved do not exclude. */
export function activeExclusionHosts(exclusions) {
  return normalizeExclusions(exclusions)
    .filter((e) => e.status === 'open' || e.status === 'reviewing')
    .map((e) => e.host);
}

export function findExclusionForHost(exclusions, host) {
  const h = normalizeHost(host);
  return normalizeExclusions(exclusions).find(
    (e) => h === e.host || h.endsWith(`.${e.host}`)
  ) || null;
}

export function upsertExclusion(list, entry) {
  const next = normalizeExclusions(list).filter((e) => e.host !== entry.host);
  next.unshift(normalizeExclusion(entry));
  return next;
}

export function updateExclusion(list, id, patch) {
  return normalizeExclusions(list).map((e) => {
    if (e.id !== id) return e;
    return normalizeExclusion({
      ...e,
      ...patch,
      id: e.id,
      host: e.host,
      updatedAt: new Date().toISOString(),
    });
  });
}

export function removeExclusion(list, id) {
  return normalizeExclusions(list).filter((e) => e.id !== id);
}

/**
 * Migrate legacy allowHosts string array into exclusion objects.
 */
export function migrateAllowHostsToExclusions(allowHosts, existing = []) {
  const list = normalizeExclusions(existing);
  const have = new Set(list.map((e) => e.host));
  for (const host of allowHosts || []) {
    const h = normalizeHost(host);
    if (!h || have.has(h)) continue;
    list.push(
      createExclusion({
        host: h,
        reason: 'Migrated from allow list',
        note: 'Review and re-enable filtering when GAF handles this site.',
        source: 'migration',
        status: 'open',
      })
    );
    have.add(h);
  }
  return list;
}
