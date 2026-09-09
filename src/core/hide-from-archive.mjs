/**
 * Turn inspection-archive entries into hide rules / site CSS.
 * Spirit: archive what escaped → one click to start filtering it next time.
 */

import { cssEscapeIdent, normalizeArchiveEntry } from './archive.mjs';
import { normalizeHost, normalizeSettings } from './settings.mjs';

/** Attribute names useful for durable hide selectors (site chrome often uses these). */
const USEFUL_ATTRS = [
  'id',
  'data-testid',
  'data-test-id',
  'data-cy',
  'data-qa',
  'role',
  'aria-label',
  'data-component',
  'data-module',
  'name',
];

/** Class tokens that are usually noise (utility / hash). */
const NOISY_CLASS = /^(css-|sc-|emotion-|jsx-|svelte-|_[a-f0-9]{4,}|[a-f0-9]{8,}$|hover:|md:|lg:|sm:)/i;

/**
 * @typedef {object} HideCandidate
 * @property {string} selector
 * @property {'strong'|'medium'|'weak'} strength
 * @property {string} label  short human reason
 * @property {string} [host] when intended for host-scoped CSS
 */

function cleanSelector(sel) {
  return String(sel || '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const selector = cleanSelector(c.selector);
    if (!selector || selector.length < 2) continue;
    // Bare tags are too dangerous as global hides
    if (/^[a-z][a-z0-9]*$/i.test(selector) && !selector.includes('[') && !selector.includes('.') && !selector.includes('#')) {
      continue;
    }
    if (seen.has(selector)) continue;
    seen.add(selector);
    out.push({ ...c, selector });
  }
  return out;
}

function classTokens(className) {
  return String(className || '')
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => !NOISY_CLASS.test(c))
    .slice(0, 4);
}

/**
 * Build ranked hide-selector candidates from an archive entry.
 * @param {object} entry
 * @returns {HideCandidate[]}
 */
export function hideRuleCandidatesFromEntry(entry) {
  const e = normalizeArchiveEntry(entry);
  if (!e) return [];

  const candidates = [];
  const tag = (e.tagName || '').toLowerCase() || '*';
  const attrs = e.attributes || {};
  const host = e.host || '';

  // 1) Element id — strongest global rule
  const id = e.idAttr || attrs.id || '';
  if (id && !/^\d/.test(id)) {
    candidates.push({
      selector: `#${cssEscapeIdent(id)}`,
      strength: 'strong',
      label: 'By element id',
      host,
    });
    candidates.push({
      selector: `${tag}#${cssEscapeIdent(id)}`,
      strength: 'strong',
      label: 'Tag + id',
      host,
    });
  }

  // 2) Stable data-* / aria attributes
  for (const name of USEFUL_ATTRS) {
    if (name === 'id') continue;
    const val = attrs[name];
    if (!val || typeof val !== 'string') continue;
    const v = val.trim();
    if (!v || v.length > 80) continue;
    // Prefer contains for long labels; exact for short tokens
    if (v.length <= 40 && !/\s/.test(v)) {
      candidates.push({
        selector: `[${name}="${v.replace(/"/g, '\\"')}"]`,
        strength: name.startsWith('data-') ? 'strong' : 'medium',
        label: `Attribute ${name}`,
        host,
      });
    } else {
      const snippet = v.slice(0, 32).replace(/"/g, '');
      candidates.push({
        selector: `[${name}*="${snippet}"]`,
        strength: 'medium',
        label: `Attribute ${name} (contains)`,
        host,
      });
    }
  }

  // 3) Class-based (skip utility noise)
  const classes = classTokens(e.className);
  if (classes.length === 1) {
    candidates.push({
      selector: `${tag}.${cssEscapeIdent(classes[0])}`,
      strength: 'medium',
      label: 'Tag + class',
      host,
    });
    candidates.push({
      selector: `.${cssEscapeIdent(classes[0])}`,
      strength: 'medium',
      label: 'Class only',
      host,
    });
  } else if (classes.length >= 2) {
    candidates.push({
      selector: `${tag}.${classes.map(cssEscapeIdent).join('.')}`,
      strength: 'strong',
      label: 'Tag + classes',
      host,
    });
    candidates.push({
      selector: `.${classes.slice(0, 2).map(cssEscapeIdent).join('.')}`,
      strength: 'medium',
      label: 'Two classes',
      host,
    });
  }

  // 4) Class names that look like paywall / modal chrome
  for (const c of classes) {
    if (/paywall|regwall|modal|overlay|subscribe|newsletter|soft.?wall|piano|meter/i.test(c)) {
      candidates.push({
        selector: `.${cssEscapeIdent(c)}`,
        strength: 'strong',
        label: 'Annoyance-looking class',
        host,
      });
    }
  }

  // 5) Path selectors from selectorHint
  const hint = cleanSelector(e.selectorHint);
  if (hint) {
    candidates.push({
      selector: hint,
      strength: hint.includes('#') ? 'strong' : 'medium',
      label: 'Full path from capture',
      host,
    });
    // Last segment only (often enough, less brittle)
    const last = hint.split('>').map((s) => s.trim()).filter(Boolean).pop();
    if (last && last !== hint) {
      candidates.push({
        selector: last,
        strength: last.includes('#') || last.includes('.') ? 'medium' : 'weak',
        label: 'Last path segment',
        host,
      });
    }
  }

  // 6) Role dialog / alertdialog often used for walls
  if (attrs.role === 'dialog' || attrs.role === 'alertdialog') {
    candidates.push({
      selector: `${tag}[role="${attrs.role}"]`,
      strength: 'medium',
      label: `Role ${attrs.role}`,
      host,
    });
  }

  return uniqueCandidates(candidates);
}

/**
 * Score a candidate so durable, specific selectors win over short generic classes.
 * #id and data-testid beat ".Overlay"-style noise.
 */
export function scoreHideCandidate(c) {
  if (!c?.selector) return -Infinity;
  let score = 0;
  if (c.strength === 'strong') score += 100;
  else if (c.strength === 'medium') score += 50;
  else score += 10;

  const sel = c.selector;
  if (sel.startsWith('#')) score += 50;
  else if (sel.includes('#')) score += 35;
  if (/\[data-testid/.test(sel) || /\[data-test-id/.test(sel)) score += 30;
  if (/\[id=/.test(sel)) score += 25;
  if (/paywall|regwall|soft-?wall|subscribe|piano/i.test(sel)) score += 20;
  if (sel.includes('>') || sel.includes(' ')) score += 8;
  if (sel.includes('.') && sel.includes('[')) score += 5;

  // Generic single-class selectors are risky and often too broad
  if (/^\.[A-Za-z_-]+$/.test(sel)) {
    score -= 25;
    if (/^(overlay|modal|wrapper|container|content|root|app|main)$/i.test(sel.slice(1))) {
      score -= 40;
    }
  }

  // Mild preference for readable length (not ultra-long paths)
  score += Math.min(sel.length, 48) / 12;
  return score;
}

/**
 * Best default pick for one-click add.
 */
export function pickBestHideCandidate(entry) {
  const list = hideRuleCandidatesFromEntry(entry);
  if (!list.length) return null;
  return [...list].sort((a, b) => scoreHideCandidate(b) - scoreHideCandidate(a))[0];
}

/**
 * Append a global hide rule if not already present.
 * Ensures elementHiding is on.
 * @returns {{ settings: object, added: boolean, alreadyHad: boolean }}
 */
export function addGlobalHideRule(settings, selector) {
  const sel = cleanSelector(selector);
  const s = normalizeSettings(settings);
  if (!sel) {
    return { settings: s, added: false, alreadyHad: false };
  }
  const rules = [...(s.hideRules || [])];
  if (rules.some((r) => cleanSelector(r) === sel)) {
    return { settings: { ...s, elementHiding: true }, added: false, alreadyHad: true };
  }
  rules.push(sel);
  return {
    settings: normalizeSettings({
      ...s,
      elementHiding: true,
      hideRules: rules,
    }),
    added: true,
    alreadyHad: false,
  };
}

/**
 * Append a host-scoped hide as custom CSS (display:none rule).
 * Prefer this when a selector might be too broad globally.
 * @returns {{ settings: object, added: boolean, alreadyHad: boolean, cssLine: string }}
 */
export function addHostHideRule(settings, host, selector) {
  const h = normalizeHost(host);
  const sel = cleanSelector(selector);
  const s = normalizeSettings(settings);
  const cssLine = `${sel}{display:none!important;visibility:hidden!important;pointer-events:none!important;}`;

  if (!h || !sel) {
    return { settings: s, added: false, alreadyHad: false, cssLine };
  }

  const map = { ...(s.siteCss || {}) };
  const existing = String(map[h] || '');
  if (existing.includes(sel) && existing.includes('display:none')) {
    return {
      settings: { ...s, customCss: true },
      added: false,
      alreadyHad: true,
      cssLine,
    };
  }

  const nextCss = existing.trim()
    ? `${existing.trim()}\n/* GAF from archive */\n${cssLine}`
    : `/* GAF from archive */\n${cssLine}`;

  map[h] = nextCss;
  return {
    settings: normalizeSettings({
      ...s,
      customCss: true,
      siteCss: map,
    }),
    added: true,
    alreadyHad: false,
    cssLine,
  };
}

/**
 * Annotate archive entry that a hide rule was created.
 */
export function markArchiveEntryRuleAdded(entry, { selector, scope, host } = {}) {
  const e = normalizeArchiveEntry(entry);
  if (!e) return null;
  const stamp = new Date().toISOString();
  const noteLine = `Hide rule added (${scope || 'global'}): ${selector}${host ? ` @ ${host}` : ''} [${stamp}]`;
  const prev = e.note ? `${e.note}\n` : '';
  return {
    ...e,
    note: `${prev}${noteLine}`.trim(),
    hideRuleAdded: {
      selector: String(selector || ''),
      scope: scope === 'host' ? 'host' : 'global',
      host: normalizeHost(host || e.host || ''),
      at: stamp,
    },
  };
}

export function updateArchiveEntry(list, id, patch) {
  return (list || []).map((item) => {
    if (item?.id !== id) return item;
    return normalizeArchiveEntry({ ...item, ...patch, id: item.id });
  });
}
