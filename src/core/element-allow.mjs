/**
 * "Leave this element alone" — the reverse of uBlock's "Block element".
 *
 * The user right-clicks an object and GAF stops freezing / pausing it, and
 * remembers that for the site. Rules use uBlock's exception syntax so they
 * read the same way:  example.com#@#figure.hero > img
 *
 * An allowed element (and everything inside it) is marked with
 * data-gaf-allow. Media freeze, scripted-motion pause and the motion CSS all
 * skip marked subtrees, so the page's own playback and animation run as if
 * GAF were off for that one object.
 */

import { normalizeHost } from './settings.mjs';
import { selectorHintFor } from './archive.mjs';

export const ALLOW_ATTR = 'data-gaf-allow';
export const ALLOW_SELECTOR = `[${ALLOW_ATTR}]`;
/** CSS guard appended to motion-kill selectors. Keep in sync with early.js. */
export const NOT_ALLOWED = `:not(${ALLOW_SELECTOR}):not(${ALLOW_SELECTOR} *)`;
export const ALLOW_RULE_SEPARATOR = '#@#';
export const MAX_ALLOW_RULES = 500;
const MAX_SELECTOR_CHARS = 1000;

/** True if el is an allowed element or inside one. */
export function isAllowedElement(el) {
  try {
    return Boolean(el?.closest?.(ALLOW_SELECTOR));
  } catch {
    return false;
  }
}

function cleanSelector(selector) {
  const s = String(selector || '').trim();
  if (!s || s.length > MAX_SELECTOR_CHARS) return '';
  // A selector only — never a style block.
  if (/[{}]/.test(s)) return '';
  return s;
}

/** Normalize stored rules: [{ host, selector }], deduped and capped. */
export function normalizeAllowRules(list) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    const host = normalizeHost(r?.host);
    const selector = cleanSelector(r?.selector);
    if (!host || !selector) continue;
    const key = `${host}${ALLOW_RULE_SEPARATOR}${selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, selector });
    if (out.length >= MAX_ALLOW_RULES) break;
  }
  return out;
}

/** Rules that apply to a page host (exact host or a parent domain). */
export function allowSelectorsForHost(rules, hostname) {
  const host = normalizeHost(hostname);
  if (!host) return [];
  return normalizeAllowRules(rules)
    .filter((r) => host === r.host || host.endsWith(`.${r.host}`))
    .map((r) => r.selector);
}

export function addAllowRule(rules, host, selector) {
  return normalizeAllowRules([...(Array.isArray(rules) ? rules : []), { host, selector }]);
}

export function removeAllowRule(rules, host, selector) {
  const h = normalizeHost(host);
  const s = cleanSelector(selector);
  return normalizeAllowRules(rules).filter((r) => !(r.host === h && r.selector === s));
}

/** One rule per line: host#@#selector (uBlock exception syntax). */
export function formatAllowRules(rules) {
  return normalizeAllowRules(rules)
    .map((r) => `${r.host}${ALLOW_RULE_SEPARATOR}${r.selector}`)
    .join('\n');
}

/** Parse the Options textarea back into rules; blank and "!" comment lines are skipped. */
export function parseAllowRules(text) {
  const rules = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;
    const i = line.indexOf(ALLOW_RULE_SEPARATOR);
    if (i <= 0) continue;
    rules.push({ host: line.slice(0, i), selector: line.slice(i + ALLOW_RULE_SEPARATOR.length) });
  }
  return normalizeAllowRules(rules);
}

/**
 * The object the user meant. A frozen GIF is displayed as a GAF canvas with
 * the real <img> hidden next to it; the rule must point at the <img>.
 */
export function pickAllowTarget(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.dataset?.gafFreezeCanvas === 'true') {
    let next = el.nextElementSibling;
    while (next && next.tagName !== 'IMG') next = next.nextElementSibling;
    return next || el;
  }
  // Clicks on an overlay/caption inside a media card: prefer the media itself.
  const media = el.closest?.('video, picture, img, svg, canvas, lottie-player, dotlottie-player');
  if (media) return media.tagName === 'IMG' && media.parentElement?.tagName === 'PICTURE' ? media.parentElement : media;
  return el;
}

/** A selector that matches el in its document, or '' when none can be built. */
export function allowSelectorFor(el) {
  const doc = el?.ownerDocument;
  const sel = cleanSelector(selectorHintFor(el));
  if (!sel) return '';
  try {
    const hits = doc?.querySelectorAll?.(sel);
    if (hits && !Array.from(hits).includes(el)) return '';
  } catch {
    return '';
  }
  return sel;
}

/**
 * Mark every element matching the selectors; unmark elements that no longer
 * match (rule removed). Returns the newly marked elements.
 */
export function syncAllowMarks(doc, selectors) {
  const added = [];
  if (!doc?.querySelectorAll) return added;
  const want = new Set();
  for (const sel of selectors || []) {
    let hits = [];
    try {
      hits = doc.querySelectorAll(sel);
    } catch {
      continue; // a stale or invalid selector must not break the page
    }
    for (const el of hits) want.add(el);
  }
  for (const el of doc.querySelectorAll(ALLOW_SELECTOR)) {
    if (!want.has(el)) el.removeAttribute(ALLOW_ATTR);
  }
  for (const el of want) {
    if (!el.hasAttribute(ALLOW_ATTR)) {
      el.setAttribute(ALLOW_ATTR, '');
      added.push(el);
    }
  }
  return added;
}
