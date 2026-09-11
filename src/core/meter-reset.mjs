/**
 * Meter reset — free-article counters (Spiked and similar).
 *
 * Two layers (both needed — cookie-only failed on Spiked):
 *
 * 1) **DOM disarm** — many publishers still ship the full article HTML and only
 *    flip a CSS gate (e.g. `.gated-content-wrap.paywall.active` + fade). Incognito
 *    "works" partly because the gate never gets `active`. Hiding the gate reveals
 *    content already on the page without a round-trip.
 *
 * 2) **Cookie / storage wipe + reload** — when the server truly strips the body,
 *    clear site cookies (+ storage) and reload (same idea as a fresh profile).
 *
 * Does not invent article text. Does not target login/pay sessions specially;
 * clearing cookies may log you out of a membership on that host.
 */

import {
  normalizeHost,
  isSoftwallHost,
  looksLikeArticlePage,
  resolveSitePolicy,
} from './settings.mjs';

/** Cookie / storage name fragments that often hold free-article meters. */
export const METER_NAME_HINTS = [
  'meter',
  'paywall',
  'regwall',
  'free_art',
  'freeart',
  'free-article',
  'article_count',
  'articlecount',
  'article-count',
  'view_count',
  'viewcount',
  'read_count',
  'readcount',
  'pageview',
  'page_view',
  'gate',
  'piano',
  'tinypass',
  'zephr',
  'amp_',
  'spiked',
  'content_gate',
  'contentgate',
  'monthly',
  'entitlement',
  'access_token',
  'visit_count',
  'visitcount',
];

/**
 * Gate chrome that can be hidden when article body is already in the DOM.
 * Prefer specific wraps — never bare [class*="paywall"] (Schibsted content tags).
 */
export const METER_DISARM_SELECTORS = [
  '.gated-content-wrap.paywall',
  '.gated-content-wrap.paywall.active',
  '.gated-content-notice',
  '#support-end-article-sell',
  '[class*="free-article-limit" i]',
  '[class*="article-limit-reached" i]',
  '[data-testid*="regwall" i]',
  '[data-testid*="hard-paywall" i]',
];

/**
 * DOM markers that suggest a free-article meter wall is showing.
 */
/** Named / specific gate chrome — enough on its own to escalate a wipe. */
export const METER_WALL_STRONG_SELECTORS = [
  '.gated-content-wrap.paywall.active',
  '.gated-content-wrap.paywall',
  '[data-testid*="regwall" i]',
  '[data-testid*="hard-paywall" i]',
];

/** Generic class fragments — require matching wall text before auto-delete. */
export const METER_WALL_GENERIC_SELECTORS = [
  '[class*="free-article-limit" i]',
  '[class*="article-limit" i]',
  '[data-testid*="paywall" i]',
  '[class*="metered" i]',
];

export const METER_WALL_SELECTORS = [
  ...METER_WALL_STRONG_SELECTORS,
  ...METER_WALL_GENERIC_SELECTORS,
];

export const METER_WALL_TEXT_RE =
  /free article limit|monthly free article|you.?ve hit your|register to (?:keep )?read|sign up to (?:keep )?read|create a free account to continue|you have reached your|articles? remaining/i;

/** Minimum article body chars to treat disarm as "content available". */
export const MIN_ARTICLE_CHARS_FOR_DISARM = 400;

/**
 * Page identifier for the extension-owned automatic reset retry guard.
 * Not a single boolean for the whole origin (later articles must still run).
 */
export function meterAutoStorageKey(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return `gafMeterAutoDone:${u.origin}${u.pathname}`;
  } catch {
    return `gafMeterAutoDone:${String(pageUrl || '')}`;
  }
}

/**
 * Registrable-ish domain for display only. Cookie *queries* must use the page
 * URL (`cookies.getAll({ url })`), never this heuristic — a short suffix list
 * can collapse `foo.co.xx` to `co.xx` and pull sibling-host cookies.
 */
export function cookieDomainFromHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const multi = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'co.nz', 'co.jp']);
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (multi.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  // generic: drop leftmost labels until 2 remain
  if (parts.length > 2 && !multi.has(lastTwo)) {
    return lastTwo;
  }
  return lastThree || h;
}

export function cookieUrlFromDetails(cookie) {
  const protocol = cookie.secure ? 'https:' : 'http:';
  let domain = cookie.domain || '';
  if (domain.startsWith('.')) domain = domain.slice(1);
  const path = cookie.path || '/';
  return `${protocol}//${domain}${path}`;
}

/**
 * Whether a cookie name looks meter-related.
 */
export function looksLikeMeterCookieName(name) {
  const n = String(name || '').toLowerCase();
  if (!n || /(?:access|refresh|id)[_-]?token|session|auth|entitlement/.test(n)) return false;
  return METER_NAME_HINTS.some((hint) => n.includes(hint));
}

/**
 * Build chrome.cookies.remove details from a cookie object.
 */
export function removeDetailsForCookie(cookie) {
  if (!cookie?.name) return null;
  const details = {
    url: cookieUrlFromDetails(cookie),
    name: cookie.name,
    storeId: cookie.storeId,
  };
  // Chromium partitioned cookies (CHIPS) need partitionKey to remove
  if (cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }
  return details;
}

/**
 * Decide if meter reset should auto-fire for this page.
 * @param {string} pageUrl
 * @param {object} settings
 * @param {string[]} exclusionHosts
 * @param {{ hasWallDom?: boolean }} [hints]
 */
export function shouldAutoMeterReset(pageUrl, settings, exclusionHosts = [], hints = {}) {
  if (!settings?.meterResetEnabled) return false;
  if (!resolveSitePolicy(pageUrl, settings, exclusionHosts).active) return false;
  if (settings.features?.meterReset === false) return false;
  if (settings.meterResetMode !== 'auto') return false;
  if (!looksLikeArticlePage(pageUrl)) return false;

  let host = '';
  try {
    host = normalizeHost(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
  if (!host) return false;

  // Reuse softwall host list — same publishers use both timer and cookie meters
  const scope = settings.meterResetScope || 'softwall';
  if (scope === 'softwall') {
    if (!isSoftwallHost(host, settings)) return false;
  }
  // scope === 'all' → any article page when wall detected

  if (hints.hasWallDom === false) return false;
  return true;
}

/**
 * Whether automatic mode may escalate from DOM disarm to cookie/storage wipe.
 *
 * Requires two independent signals, or one named-adapter selector:
 *   - strongSelector (Spiked wrap, regwall testid) → enough
 *   - generic selector + wall-specific text → enough
 *   - text alone, generic class alone, or short body → not enough
 *
 * Manual popup / context-menu reset is not gated by this helper.
 *
 * @param {{
 *   strongSelector?: boolean,
 *   selectorHit?: boolean,
 *   textHit?: boolean,
 *   wallDetected?: boolean,
 *   disarmUseful?: boolean,
 *   articleChars?: number,
 * }} signals
 * @returns {boolean}
 */
export function shouldEscalateMeterWipe(signals = {}) {
  if (signals.disarmUseful) return false;
  if (signals.strongSelector) return true;
  return Boolean(signals.selectorHit && signals.textHit);
}

function isDisplayed(el, doc) {
  if (!el) return false;
  if (el.getAttribute?.('data-gaf-meter-disarmed') === '1') return false;
  const style = doc?.defaultView?.getComputedStyle?.(el);
  if (!style) {
    // no layout engine (tests): treat presence as visible unless display:none inline
    if (el.style?.display === 'none' || el.hidden) return false;
    return true;
  }
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  try {
    const r = el.getBoundingClientRect?.();
    if (r && r.width === 0 && r.height === 0) return false;
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Heuristic: document looks like a free-article meter wall is active.
 * Pure DOM helper for content scripts / tests.
 */
export function detectMeterWall(doc) {
  const empty = {
    detected: false,
    reason: 'no-doc',
    selector: null,
    strongSelector: false,
    selectorHit: false,
    textHit: false,
  };
  if (!doc?.querySelector) return empty;

  const scan = (selectors) => {
    for (const sel of selectors) {
      try {
        const nodes = doc.querySelectorAll(sel);
        for (const el of nodes) {
          // Spiked: without .active the wrap is display:none — not a live wall
          if (
            el.classList?.contains?.('paywall') &&
            !el.classList?.contains?.('active') &&
            !sel.includes('active')
          ) {
            if (!isDisplayed(el, doc)) continue;
          }
          if (el.classList?.contains?.('active') || isDisplayed(el, doc)) {
            return sel;
          }
        }
      } catch {
        /* invalid selector */
      }
    }
    return null;
  };

  const strongSel = scan(METER_WALL_STRONG_SELECTORS);
  const genericSel = strongSel ? null : scan(METER_WALL_GENERIC_SELECTORS);
  const text = (doc.body?.innerText || '').slice(0, 4000);
  const textHit = METER_WALL_TEXT_RE.test(text);
  const selectorHit = Boolean(strongSel || genericSel);
  const detected = selectorHit || textHit;
  let reason = 'none';
  if (strongSel) reason = 'strong-selector';
  else if (genericSel && textHit) reason = 'selector+text';
  else if (genericSel) reason = 'generic-selector';
  else if (textHit) reason = 'text';

  return {
    detected,
    reason,
    selector: strongSel || genericSel,
    strongSelector: Boolean(strongSel),
    selectorHit,
    textHit,
  };
}

/**
 * Rough article body length (excludes nav/footer when possible).
 */
export function measureArticleText(doc) {
  if (!doc?.querySelector) return 0;
  const roots = doc.querySelectorAll(
    'article, #normal-article, .entry-content, .post-content, .cms, main .serif.cms, [itemprop="articleBody"]'
  );
  let best = 0;
  for (const root of roots) {
    if (root.closest?.('.gated-content-wrap, nav, header, footer')) continue;
    const t = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > best) best = t.length;
  }
  if (best > 0) return best;
  // fallback: body minus obvious chrome
  const body = (doc.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return Math.min(body.length, 20000);
}

const meterChanges = new WeakMap();
const METER_STYLE_PROPERTIES = ['display', 'pointer-events', 'visibility'];

/** Undo only properties still carrying the values GAF wrote. */
export function restoreMeterWall(doc) {
  const changes = meterChanges.get(doc);
  if (changes) {
    for (const [el, saved] of changes) {
      for (const [property, value, priority] of saved.styles) {
        const written = property === 'display' ? 'none' : property === 'visibility' ? 'hidden' : 'none';
        if (el.style?.getPropertyValue?.(property) !== written) continue;
        if (value) el.style.setProperty(property, value, priority);
        else el.style.removeProperty(property);
      }
      if (saved.active) el.classList?.add?.('active');
      if (saved.marker == null) el.removeAttribute?.('data-gaf-meter-disarmed');
      else el.setAttribute('data-gaf-meter-disarmed', saved.marker);
    }
    meterChanges.delete(doc);
  }
  doc?.getElementById?.('gaf-meter-disarm-style')?.remove?.();
}

/**
 * Hide / deactivate free-article gate chrome so already-delivered body is readable.
 * Safe when article text is present; no-op-ish when the server never sent the body.
 *
 * @returns {{ hidden: number, activeRemoved: number, articleChars: number, useful: boolean }}
 */
export function disarmMeterWall(doc) {
  const result = { hidden: 0, activeRemoved: 0, articleChars: 0, useful: false };
  if (!doc?.querySelectorAll) return result;

  result.articleChars = measureArticleText(doc);
  if (!meterChanges.has(doc)) meterChanges.set(doc, new Map());
  const changes = meterChanges.get(doc);

  for (const sel of METER_DISARM_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!changes.has(el)) changes.set(el, {
        active: Boolean(el.classList?.contains?.('active')),
        marker: el.getAttribute?.('data-gaf-meter-disarmed'),
        styles: METER_STYLE_PROPERTIES.map((property) => [property,
          el.style?.getPropertyValue?.(property) || '', el.style?.getPropertyPriority?.(property) || '']),
      });
      if (el.classList?.contains?.('active')) {
        el.classList.remove('active');
        result.activeRemoved += 1;
      }
      try {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.setAttribute('data-gaf-meter-disarmed', '1');
        result.hidden += 1;
      } catch {
        /* ignore */
      }
    }
  }

  // Kill fade masks that sit above truncated article regions (Spiked ::before uses --fade-up)
  try {
    let styleEl = doc.getElementById('gaf-meter-disarm-style');
    if (!styleEl && doc.createElement) {
      styleEl = doc.createElement('style');
      styleEl.id = 'gaf-meter-disarm-style';
      styleEl.setAttribute('data-gaf', 'meter-disarm');
      styleEl.textContent = `
/* GAF meter disarm — show body already in the page */
.gated-content-wrap.paywall,
.gated-content-wrap.paywall.active,
.gated-content-notice,
[data-gaf-meter-disarmed="1"] {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
}
.gated-content-wrap.paywall::before,
.gated-content-wrap.paywall.active::before {
  display: none !important;
  content: none !important;
  height: 0 !important;
}
.article-overflow,
.article-overflow-more {
  max-height: none !important;
  overflow: visible !important;
  height: auto !important;
  -webkit-line-clamp: unset !important;
  mask-image: none !important;
  -webkit-mask-image: none !important;
}
`.trim();
      (doc.head || doc.documentElement)?.appendChild?.(styleEl);
    }
  } catch {
    /* ignore */
  }

  result.useful =
    result.hidden > 0 && result.articleChars >= MIN_ARTICLE_CHARS_FOR_DISARM;
  return result;
}

/**
 * Whether GAF should auto-disarm meter chrome on this page.
 */
export function shouldDisarmMeterOnPage(pageUrl, settings, exclusionHosts = []) {
  if (!settings?.meterResetEnabled) return false;
  if (settings.features?.meterReset === false) return false;
  if (settings.meterDisarm === false) return false;
  const policy = resolveSitePolicy(pageUrl, settings, exclusionHosts);
  if (!policy.active) return false;
  const scope = settings.meterResetScope || 'softwall';
  if (scope === 'all') {
    return looksLikeArticlePage(pageUrl) || isSoftwallHost(policy.host, settings);
  }
  // softwall scope: soft-wall hosts always; other hosts only on article paths if listed later
  return isSoftwallHost(policy.host, settings);
}

/**
 * Clear cookies for a host. Pure orchestration; inject chrome.cookies via deps for tests.
 * @param {string} pageUrl
 * @param {{ mode?: 'all' | 'meter-names', cookiesApi?: typeof chrome.cookies }} [options]
 */
export async function clearCookiesForPageUrl(pageUrl, options = {}) {
  const mode = options.mode || 'all';
  const api = options.cookiesApi || globalThis.chrome?.cookies;
  if (!api?.getAll || !api?.remove) {
    return { ok: false, removed: 0, error: 'cookies-api-unavailable' };
  }

  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return { ok: false, removed: 0, error: 'invalid-url' };
  }
  if (!/^https?:$/i.test(url.protocol)) {
    return { ok: false, removed: 0, error: 'not-http' };
  }

  const collected = new Map();

  const addList = (list) => {
    for (const c of list || []) {
      const key = `${c.storeId || ''}|${c.domain}|${c.path}|${c.name}`;
      collected.set(key, c);
    }
  };

  // Only cookies that would be sent to this page URL. Do not query by
  // registrable domain — that includes sibling hosts (shop.example.com
  // while we are on www.example.com) and can over-collapse multi-part suffixes.
  try {
    addList(await api.getAll({ url: pageUrl }));
  } catch {
    /* ignore */
  }

  let removed = 0;
  const names = [];
  for (const cookie of collected.values()) {
    if (options.canProceed && !(await options.canProceed())) {
      return { ok: false, removed, names, error: 'cancelled' };
    }
    if (mode === 'meter-names' && !looksLikeMeterCookieName(cookie.name)) {
      continue;
    }
    const details = removeDetailsForCookie(cookie);
    if (!details) continue;
    try {
      const result = await api.remove(details);
      if (result) {
        removed += 1;
        names.push(cookie.name);
      }
    } catch {
      /* ignore single cookie failures */
    }
  }

  return {
    ok: true,
    removed,
    names,
    domain: url.hostname,
    mode,
  };
}
