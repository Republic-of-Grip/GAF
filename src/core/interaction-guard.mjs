/**
 * Interaction guard — clear full-viewport dimmers / body locks that block the page.
 *
 * Shop themes (Hyvä / Magento / Alpine) use fixed semi-transparent layers
 * (.backdrop, role=overlay, filter scrims, cookie greys). Verified live on
 * ditur.no (Orient Bambino PLP, Helium GAF Debug CDP 2026-07):
 *
 *  - Cookie wall: body gets `noscroll` + `phantom-scroll-bar`, full-viewport
 *    `fixed inset-0 bg-gray-500/75` dimmer, dialog "Vi tilpasser opplevelsen din"
 *    with **Godta valgte** / **Godta alle**. Accepting uncovers the catalog.
 *  - Escape / click-away only "wiggles" until accept (canClose=false).
 *
 * Strategy:
 *  1) Page-locking consent with cookie-panel evidence → click exactly one
 *     least-privilege control, via exactly one event path (MAIN world when the
 *     page helper is reachable, otherwise a single isolated `click()`).
 *  2) If no explicit reject/necessary-only choice exists, leave consent visible.
 *     Never infer consent from selected categories or seed a consent cookie.
 *  3) Orphan dimmer with no usable non-consent dialog → hide + unlock.
 *  4) Login / cart / filter / age-gate panels → leave alone.
 *  5) BankID / Morrow payment-auth windows → leave alone (not a cookie grey).
 *     GAF has no window.open interceptor. The false block is hiding the
 *     3DS overlay: a full-viewport scrim around a cross-origin BankID
 *     iframe has no readable text, so it looks like an empty dimmer.
 */

/** Selectors that commonly host full-screen interaction blockers. */
export const DIMMER_SELECTORS = [
  '.backdrop',
  '[role="overlay"]',
  '#confirmOverlay',
  '#ditur-popup-container',
  '#ditur-popup-overlay',
  '#authentication-popup [role="overlay"]',
  // Ditur Hyvä cookie / filter greys (live DOM)
  '[class*="bg-gray-500/75"]',
  '[class*="bg-opacity-50"][class*="fixed"]',
  '[class*="bg-black/50"]',
  '[class*="bg-black/60"]',
  '[class*="bg-white/50"]',
];

/** Dialog / panel roots that count as "usable modal chrome". */
export const MODAL_CONTENT_SELECTORS = [
  '[role="dialog"]',
  'dialog',
  // X.com compose / many SPAs use aria-modal without always exposing role=dialog early
  '[aria-modal="true"]',
  '#cookie-popup',
  '#ditur-popup-content',
  '#confirmBox',
  '.amcart-confirm-block',
  '#authentication-popup [role="dialog"]',
  '#diturelastic-filters',
  '#mobile-filter-bar',
  // FilterBlade / generic app modals (must not be unstuck as "orphan greys")
  '.ModalBox_Outer',
  '.ModalBox_Container',
  '.ModalBox_Content',
  '[class*="ModalBox"]',
  // X / Twitter compose + media viewer chrome
  '[data-testid="tweetTextarea_0"]',
  '[data-testid="toolBar"]',
  '[data-testid="sheetDialog"]',
  '[data-testid="confirmationSheetDialog"]',
];

/** Roots that look like first-party cookie / consent walls. */
export const CONSENT_ROOT_SELECTORS = [
  '#cookie-popup',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '#ditur-popup-container',
  '#ditur-popup-content',
];

/** Only explicit rejection / necessary-only choices are safe to automate. */
export const CONSENT_MINIMAL_BTN_RE =
  /^(?:necessary only|only necessary|kun n[øo]dvendige?|bare n[øo]dvendige?|avvis alle|reject all|decline all|deny all|refuse all)(?: cookies| informasjonskapsler)?[.!]?$/i;

export const CONSENT_FULL_BTN_RE =
  /godta alle|accept all|allow all|aksepter alle|jeg godtar|i agree|allow cookies|accept cookies|godta$/i;

/**
 * Cookie / consent wall copy. Do NOT match bare "privacy" — app settings
 * (Grok Account, many SPAs) use that word and were force-hidden as "consent".
 */
export const CONSENT_TEXT_RE =
  /cookie|cookies|personvern|gdpr|consent|samtykke|vi tilpasser|privacy policy|cookie policy|personvernpolicy|informasjonskapsler|we use cookies|vi bruker cookies/i;

/** Prefer Hyvä/consent locks; overflow-hidden alone is common on video players. */
const BODY_LOCK_CLASSES = [
  'noscroll',
  'modal-open',
  'no-scroll',
  'phantom-scroll-bar',
  'overflow-hidden', // still clear when force-uncovering consent walls
];

/**
 * Parse CSS color alpha roughly. Returns 1 when opaque/unknown, 0 when transparent.
 */
export function cssColorAlpha(color) {
  if (!color || color === 'transparent') return 0;
  const s = String(color).trim().toLowerCase();
  if (s === 'transparent') return 0;
  const rgba = s.match(
    /rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/,
  );
  if (rgba) {
    if (rgba[4] === undefined) return 1;
    const a = rgba[4].endsWith('%') ? parseFloat(rgba[4]) / 100 : parseFloat(rgba[4]);
    return Number.isFinite(a) ? a : 1;
  }
  const modern = s.match(/\/\s*([\d.]+%?)\s*\)/);
  if (modern) {
    const a = modern[1].endsWith('%') ? parseFloat(modern[1]) / 100 : parseFloat(modern[1]);
    return Number.isFinite(a) ? a : 1;
  }
  return 1;
}

/**
 * True if a CSS filter/backdrop-filter actually frosts the page.
 * `blur(0px)` is a no-op (common on idle nav scrims) and must not count.
 */
export function cssFilterIsActive(value) {
  if (!value) return false;
  const s = String(value).trim().toLowerCase();
  if (!s || s === 'none') return false;
  const stripped = s
    .replace(/blur\(\s*0(?:px|em|rem|%)?\s*\)/g, '')
    .replace(/\bnone\b/g, '')
    .replace(/[,/\s]+/g, ' ')
    .trim();
  return stripped.length > 0;
}

/**
 * Marketing / product-site chrome that is full-viewport by design but is not
 * an orphan cookie/shop dimmer: nav scrims, card image tints, first-party
 * cookie banners. Pattern-based (ids/classes), never a host allowlist.
 */
export function isMarketingChromeLayer(el) {
  if (!el) return false;
  const id = String(el.id || '');
  const cls = typeof el.className === 'string' ? el.className : '';
  if (/^nav[-_]?backdrop$/i.test(id)) return true;
  if (id === 'cookie-banner' || id === 'cookie-form') return true;
  if (/(^|\s)bg-image-overlay(\s|$)/i.test(cls)) return true;
  return false;
}

/**
 * BankID / Morrow 3DS hosts. Keep in sync with settings.mjs PAYMENT_AUTH_HOST_RE.
 * Not a general popup allowlist — only first-party payment-auth windows.
 */
export const PAYMENT_AUTH_HOST_RE =
  /(^|\.)(bankid\.no|morrowbank\.no|morrowbank\.com)$/i;

/**
 * Copy that only belongs on the national-ID / BankID challenge, not cookie walls.
 * "fødselsnummer" is the Starlink/Morrow step; "BankID" is the client itself.
 */
export const PAYMENT_AUTH_TEXT_RE =
  /bankid|morrow\s*bank|f[øo]dselsnummer|nasjonalt\s+identitetsnummer/i;

function paymentAuthHostName(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .trim();
  return Boolean(h && PAYMENT_AUTH_HOST_RE.test(h));
}

/** True if an iframe/window URL is BankID or Morrow payment-auth. */
export function isPaymentAuthSrc(src) {
  if (!src || typeof src !== 'string') return false;
  const s = src.trim();
  if (!s || /^about:blank$/i.test(s) || s.startsWith('javascript:')) return false;
  try {
    const u = new URL(s, 'https://gaf.invalid');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (paymentAuthHostName(u.hostname)) return true;
    }
  } catch {
    /* fall through */
  }
  return /(?:^|[/.])(bankid\.no|morrowbank\.no|morrowbank\.com)(?:[/?#:]|$)/i.test(s);
}

function iframeLooksLikePaymentAuth(frame) {
  if (!frame) return false;
  const src = frame.getAttribute?.('src') || frame.src || '';
  if (isPaymentAuthSrc(src)) return true;
  const id = String(frame.id || frame.getAttribute?.('id') || '');
  const name = frame.getAttribute?.('name') || '';
  const title = frame.getAttribute?.('title') || '';
  return /bankid|morrowbank/i.test(id) || PAYMENT_AUTH_TEXT_RE.test(`${name} ${title}`);
}

/**
 * True if this node is (or hosts) a BankID / Morrow payment-auth window.
 * Cross-origin iframes have empty innerText — host/src is the signal.
 */
export function isPaymentAuthLayer(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'IFRAME' && iframeLooksLikePaymentAuth(el)) return true;
  const id = String(el.id || '');
  const cls = typeof el.className === 'string' ? el.className : '';
  if (/bankid|morrowbank/i.test(id) || /bankid|morrowbank/i.test(cls)) return true;
  try {
    const frames = el.querySelectorAll?.('iframe');
    if (frames) {
      for (const f of frames) {
        if (iframeLooksLikePaymentAuth(f)) return true;
      }
    }
  } catch {
    /* ignore */
  }
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  return PAYMENT_AUTH_TEXT_RE.test(text);
}

/** True if the document currently hosts BankID / Morrow auth (iframe or challenge copy). */
export function documentHasPaymentAuth(doc) {
  if (!doc) return false;
  try {
    for (const f of doc.querySelectorAll?.('iframe') || []) {
      if (iframeLooksLikePaymentAuth(f) || isPaymentAuthLayer(f)) return true;
    }
  } catch {
    /* ignore */
  }
  const sels = [
    '[role="dialog"]',
    'dialog',
    '[aria-modal="true"]',
    '[role="overlay"]',
    '.backdrop',
    '#authentication-popup',
  ];
  for (const sel of sels) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (isPaymentAuthLayer(el)) return true;
    }
  }
  return false;
}

/**
 * True if body classes/styles look scroll-locked (Hyvä noscroll etc.).
 */
export function isPageScrollLocked(doc) {
  const body = doc?.body;
  if (!body) return false;
  for (const cls of BODY_LOCK_CLASSES) {
    if (body.classList?.contains?.(cls)) return true;
  }
  const style = body.style;
  if (style?.overflow === 'hidden' || style?.overflowY === 'hidden') return true;
  if (style?.position === 'fixed') return true;
  return false;
}

/**
 * True if element looks like a full-viewport dimmer that intercepts clicks.
 * @param {Element} el
 * @param {{ getComputedStyle?: Function, innerWidth?: number, innerHeight?: number }} [view]
 */
export function isBlockingDimmer(el, view = globalThis) {
  if (!el || el.nodeType !== 1) return false;
  const win = view.defaultView || view;
  const getStyle = view.getComputedStyle || win?.getComputedStyle?.bind(win);
  if (el.getAttribute?.('data-gaf-unstuck') === '1') return false;
  if (isMarketingChromeLayer(el)) return false;
  // BankID / Morrow 3DS overlay: cross-origin iframe reads as an empty scrim.
  if (isPaymentAuthLayer(el)) return false;
  if (typeof getStyle !== 'function') {
    return el.dataset?.gafTestDimmer === '1';
  }
  const style = getStyle(el);
  if (!style) return false;
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (style.pointerEvents === 'none') return false;
  const opacity = parseFloat(style.opacity);
  if (Number.isFinite(opacity) && opacity < 0.05) return false;
  const pos = style.position;
  if (pos !== 'fixed' && pos !== 'absolute') return false;

  const iw = view.innerWidth || win?.innerWidth || 0;
  const ih = view.innerHeight || win?.innerHeight || 0;
  if (iw < 100 || ih < 100) return false;

  let width = 0;
  let height = 0;
  try {
    const r = el.getBoundingClientRect?.();
    width = r?.width || 0;
    height = r?.height || 0;
  } catch {
    return false;
  }
  if (width < iw * 0.8 || height < ih * 0.8) return false;

  const tag = String(el.tagName || '').toUpperCase();
  // Media and page landmarks are the document, not a leftover grey.
  // A 100vh <video> with a transparent computed background must not be treated
  // as a scroll-lock click-catcher (marketing heroes go blank if hidden).
  if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'CANVAS' || tag === 'IMG' || tag === 'PICTURE') {
    return false;
  }
  if (tag === 'MAIN' || tag === 'ARTICLE' || tag === 'HEADER' || tag === 'NAV' || tag === 'HTML' || tag === 'BODY') {
    return false;
  }
  if (isPageContentLayer(el, view)) return false;

  const cls = typeof el.className === 'string' ? el.className : '';
  // Never treat app UI modals as orphan dimmers (FilterBlade ModalBox_Outer, etc.)
  if (/ModalBox|modal-box|dialog-overlay|MuiModal|ReactModal|chakra-modal/i.test(cls)) {
    return false;
  }
  if (el.id === 'cookie-popup') return false; // content root, handled separately

  // X/Twitter: full-viewport compose/media masks are app UI, not cookie greys.
  // Hiding them lets clicks fall through to the timeline (reply compose dead).
  const testId = el.getAttribute?.('data-testid') || '';
  if (
    testId === 'mask' ||
    testId === 'twc-cc-mask' ||
    testId === 'sheetDialog' ||
    testId === 'confirmationSheetDialog' ||
    testId === 'toolBar' ||
    testId === 'tweetTextarea_0'
  ) {
    return false;
  }
  // Compose stack often wraps mask + dialog; never hide if it hosts the tweet box
  try {
    if (
      el.querySelector?.(
        '[data-testid="tweetTextarea_0"], [data-testid="toolBar"], [data-testid="tweetButton"], [data-testid="tweetButtonInline"], [contenteditable="true"][data-testid], [role="textbox"]',
      )
    ) {
      return false;
    }
  } catch {
    /* ignore */
  }

  const alpha = cssColorAlpha(style.backgroundColor);
  const hasBlur =
    cssFilterIsActive(style.backdropFilter) || cssFilterIsActive(style.webkitBackdropFilter);

  // Ditur Hyvä: empty #confirmOverlay / #ditur-popup-overlay is the grey scrim.
  // Tirsdagsquizen reuses #confirmOverlay for the submit dialog (buttons +
  // "Dine svar") — hide only when it is still an empty catcher.
  if (el.id === 'confirmOverlay' || el.id === 'ditur-popup-overlay') {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 24) return false;
    if (el.querySelector?.('button, a, input, select, textarea, [role="button"]')) {
      return false;
    }
    return true;
  }
  if (/bg-gray-500\/75|bg-opacity-50|bg-black\/[456]|bg-white\/50/i.test(cls)) return true;
  if (/\bbackdrop\b/i.test(cls) || el.getAttribute?.('role') === 'overlay') {
    // Only if it looks empty (true scrim), not a content modal host
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 24) return true;
    return false;
  }

  // Semi-transparent full-viewport: only a dimmer if mostly empty.
  // FilterBlade strictness UI is fixed + dark and MUST NOT match.
  if ((alpha > 0.02 && alpha < 0.95) || hasBlur) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 24) return false;
    if (el.querySelector?.('button, a, input, select, textarea, [role="button"]')) {
      // Content chrome inside — not an orphan scrim
      return false;
    }
    return true;
  }

  // Ditur: transparent fixed catcher only with shop scroll-lock / cookie stack
  if (alpha <= 0.02) {
    try {
      const doc = el.ownerDocument || globalThis.document;
      const locked =
        doc?.body?.classList?.contains?.('noscroll') ||
        doc?.body?.classList?.contains?.('phantom-scroll-bar') ||
        doc?.querySelector?.('#cookie-popup');
      if (locked) {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 24) return false;
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * True if this full-viewport node is the page (hero, landing shell) rather than
 * an orphan shop/cookie dimmer. Hiding these blanks marketing/product sites.
 */
export function isPageContentLayer(el, view = globalThis) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'MAIN' || tag === 'ARTICLE' || tag === 'HEADER' || tag === 'NAV') return true;
  try {
    if (el.querySelector?.('main, article, [role="main"]')) return true;
  } catch {
    /* ignore */
  }
  try {
    const media = el.querySelector?.('video, canvas');
    if (media) {
      const win = view.defaultView || view;
      const iw = Number(view.innerWidth || win?.innerWidth) || 0;
      const ih = Number(view.innerHeight || win?.innerHeight) || 0;
      const r = media.getBoundingClientRect?.();
      if (r && iw >= 100 && ih >= 100 && r.width >= iw * 0.45 && r.height >= ih * 0.35) {
        return true;
      }
      const er = el.getBoundingClientRect?.();
      if (r && er && er.width > 80 && r.width >= er.width * 0.5 && r.height >= er.height * 0.4) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function visibleModalLike(el, getStyle) {
  if (!el) return false;
  if (el.dataset?.gafTestConsent === '1' || el.dataset?.gafTestDimmer === '1') return true;
  if (typeof getStyle === 'function') {
    const style = getStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
    try {
      const r = el.getBoundingClientRect?.();
      // Consent panels can report 0×0 while a parent [aria-modal] stack is open —
      // still treat as present if text/buttons exist (checked by caller).
      if (r && r.width >= 40 && r.height >= 40) return true;
      if (r && (r.width > 0 || r.height > 0)) return true;
    } catch {
      /* fall through */
    }
    // x-show may leave display:block with zero box on closed Alpine nodes
    return false;
  }
  if (el.hidden || el.style?.display === 'none') return false;
  return true;
}

function panelText(el) {
  return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * True if a usable modal panel is on screen (text / form).
 */
export function hasUsableModalContent(doc, view = globalThis) {
  if (!doc?.querySelectorAll) return false;
  // BankID iframe is usable chrome even when parent text is empty (cross-origin).
  if (documentHasPaymentAuth(doc)) return true;
  const win = view.defaultView || view;
  const getStyle = view.getComputedStyle || win?.getComputedStyle?.bind(win);

  for (const sel of MODAL_CONTENT_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (el.dataset?.gafTestDimmer === '1') continue;
      if (!visibleModalLike(el, getStyle)) continue;
      const text = panelText(el);
      if (text.length >= 12) return true;
      if (el.querySelector?.('form, input, button, a[href]')) return true;
    }
  }
  return false;
}

/**
 * True if panel looks like a cookie / consent wall (not login/cart/filters/app settings).
 * Accept buttons are the strongest signal; bare "privacy policy" text is not enough
 * (Grok Account/Usage and similar SPAs were misclassified).
 */
export function isConsentLikePanel(el) {
  if (!el) return false;
  // Payment-auth copy often includes personvern links; that is not a cookie wall.
  if (isPaymentAuthLayer(el)) return false;
  if (el.id === 'cookie-popup' || el.id === 'ditur-popup-content') return true;
  const text = panelText(el);
  if (text.length < 8) return false;
  // Cookie-specific copy is required. A lone "I agree" / "Accept all" button is
  // not enough (age gates, TOS, onboarding).
  return CONSENT_TEXT_RE.test(text);
}

/** True if the document has cookie/consent copy, not just a matching button. */
export function documentHasCookieEvidence(doc) {
  if (!doc) return false;
  const text = panelText(doc.body || doc.documentElement || {});
  return CONSENT_TEXT_RE.test(text);
}

/**
 * Select only an explicit reject-all or necessary-only choice.
 * @returns {{ el: Element, label: string, kind: 'minimal' } | null}
 */
export function findConsentAcceptButton(root) {
  if (!root?.querySelectorAll) return null;
  const buttons = root.querySelectorAll(
    'button, [role="button"], a.button, input[type="button"], input[type="submit"]',
  );
  let minimal = null;
  for (const btn of buttons) {
    if (btn.disabled) continue;
    const label = (btn.innerText || btn.textContent || btn.value || btn.getAttribute?.('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || label.length > 80) continue;
    if (CONSENT_MINIMAL_BTN_RE.test(label) && !minimal) {
      minimal = { el: btn, label, kind: 'minimal' };
    }
  }
  return minimal;
}

/** Search whole document for consent accept buttons (not only inside known roots). */
export function findConsentAcceptButtonInDocument(doc) {
  if (!doc?.querySelectorAll) return null;
  return findConsentAcceptButton(doc.body || doc.documentElement || doc);
}

const CONSENT_TARGET_ATTR = 'data-gaf-consent-target';

/**
 * Ask MAIN-world helper (time-freeze-main.js) to click one element.
 * Returns true only when a postMessage was actually sent.
 */
export function requestMainWorldClick(view, { selector } = {}) {
  if (!selector) return false;
  const win = view?.defaultView || view;
  if (!win || typeof win.postMessage !== 'function') return false;
  try {
    win.postMessage({ source: 'gaf-extension', type: 'GAF_PAGE_CLICK', selector }, '*');
    return true;
  } catch {
    return false;
  }
}

/**
 * Click exactly one consent control via exactly one event path.
 * Prefers MAIN-world (Alpine @click). Falls back to a single isolated `click()`
 * only when the page helper cannot be reached. Never both, never a second
 * synthetic dispatch, never a second regex sweep.
 * @returns {{ ok: boolean, path: 'main'|'isolated'|null }}
 */
export function clickConsentControl(hit, view) {
  if (!hit?.el) return { ok: false, path: null };
  const token = `g${Math.random().toString(36).slice(2, 10)}`;
  try {
    hit.el.setAttribute?.(CONSENT_TARGET_ATTR, token);
  } catch {
    /* ignore */
  }
  const selector = `[${CONSENT_TARGET_ATTR}="${token}"]`;
  if (requestMainWorldClick(view, { selector })) {
    return { ok: true, path: 'main' };
  }
  try {
    hit.el.removeAttribute?.(CONSENT_TARGET_ATTR);
  } catch {
    /* ignore */
  }
  try {
    hit.el.click?.();
    return { ok: true, path: 'isolated' };
  } catch {
    return { ok: false, path: null };
  }
}

/**
 * Dismiss a page-locking first-party cookie wall by clicking the least-privilege
 * accept control (ditur: Godta valgte → necessary categories only).
 * @returns {{ dismissed: boolean, button: string|null, kind: string|null, unlocked: boolean }}
 */
export function dismissBlockingConsentWall(doc, view = globalThis) {
  const result = { dismissed: false, button: null, kind: null, unlocked: false };
  if (!doc?.querySelectorAll) return result;

  const win = view.defaultView || view;
  const getStyle = view.getComputedStyle || win?.getComputedStyle?.bind(win);
  const locked = isPageScrollLocked(doc);

  let hasDimmer = hasBlockingDimmer(doc, view);
  if (!locked && !hasDimmer) return result;

  const seen = new Set();
  for (const sel of CONSENT_ROOT_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      const force = el.dataset?.gafTestConsent === '1';
      if (!force && !visibleModalLike(el, getStyle)) {
        // Still try if locked + consent text (Alpine zero-box quirk)
        if (!(locked && isConsentLikePanel(el))) continue;
      }
      if (!isConsentLikePanel(el) && !force) continue;
      const hit = findConsentAcceptButton(el);
      if (!hit) continue;
      const clicked = clickConsentControl(hit, view);
      if (!clicked.ok) continue;
      result.dismissed = true;
      result.button = hit.label;
      result.kind = hit.kind;
      result.path = clicked.path;
      result.unlocked = unlockBodyScroll(doc);
      return result;
    }
  }

  return result;
}

export function hasBlockingDimmer(doc, view = globalThis) {
  if (!doc?.querySelectorAll) return false;
  for (const sel of DIMMER_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (isBlockingDimmer(el, view) || el.dataset?.gafTestDimmer === '1') return true;
    }
  }
  try {
    for (const el of doc.body?.children || []) {
      if (isBlockingDimmer(el, view) || el.dataset?.gafTestDimmer === '1') return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Restore body scroll lock classes/styles commonly set by Alpine shop themes.
 */
export function unlockBodyScroll(doc) {
  const body = doc?.body;
  if (!body) return false;
  let changed = false;
  for (const cls of BODY_LOCK_CLASSES) {
    if (body.classList?.contains?.(cls)) {
      body.classList.remove(cls);
      changed = true;
    }
  }
  const style = body.style;
  if (style) {
    for (const prop of ['overflow', 'overflowY', 'position', 'top', 'left', 'right']) {
      if (style[prop]) {
        style[prop] = '';
        changed = true;
      }
    }
  }
  // Also clear html overflow lock
  const root = doc.documentElement;
  if (root?.style) {
    for (const prop of ['overflow', 'overflowY']) {
      if (root.style[prop]) {
        root.style[prop] = '';
        changed = true;
      }
    }
  }
  if (root?.classList?.contains?.('noscroll')) {
    root.classList.remove('noscroll');
    changed = true;
  }
  return changed;
}

/**
 * Hide a single dimmer without removing it from the DOM (Alpine may own it).
 */
export function hideDimmer(el) {
  if (!el?.style) return false;
  try {
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    el.style.setProperty('opacity', '0', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.setAttribute?.('data-gaf-unstuck', '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Reverse hideDimmer / early unstick mutations so toggling GAF off does not
 * leave dead masks (X photo viewer / compose still broken until refresh).
 * Does not re-apply body scroll locks — the page app owns those.
 * @returns {{ restored: number, forceClassCleared: boolean }}
 */
export function restoreInteractionUnlock(doc = globalThis.document) {
  const result = { restored: 0, forceClassCleared: false };
  if (!doc?.querySelectorAll) return result;

  const marked = [];
  try {
    marked.push(
      ...doc.querySelectorAll(
        '[data-gaf-unstuck="1"], [data-gaf-blocker="1"], [data-gaf-consent-stack="1"]',
      ),
    );
  } catch {
    /* ignore */
  }

  for (const el of marked) {
    try {
      el.style?.removeProperty?.('display');
      el.style?.removeProperty?.('pointer-events');
      el.style?.removeProperty?.('opacity');
      el.style?.removeProperty?.('visibility');
      // Fallback when removeProperty is missing (tests / older DOM mocks)
      if (el.style && !el.style.removeProperty) {
        el.style.display = '';
        el.style.pointerEvents = '';
        el.style.opacity = '';
        el.style.visibility = '';
      }
      el.removeAttribute?.('data-gaf-unstuck');
      el.removeAttribute?.('data-gaf-blocker');
      el.removeAttribute?.('data-gaf-consent-stack');
      if (el.dataset) {
        delete el.dataset.gafUnstuck;
        delete el.dataset.gafBlocker;
        delete el.dataset.gafConsentStack;
      }
      result.restored += 1;
    } catch {
      /* ignore */
    }
  }

  try {
    const root = doc.documentElement;
    if (root?.classList?.contains?.('gaf-force-unlock')) {
      root.classList.remove('gaf-force-unlock');
      result.forceClassCleared = true;
    }
  } catch {
    /* ignore */
  }

  try {
    doc.getElementById?.('gaf-force-unlock-style')?.remove?.();
  } catch {
    /* ignore */
  }

  return result;
}

/**
 * Hide leftover full-viewport greys (and optional consent chrome).
 */
export function hideBlockingDimmers(doc, view, seen = new Set(), { hideConsentChrome = false } = {}) {
  let cleared = 0;
  for (const sel of DIMMER_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.getAttribute?.('data-gaf-unstuck') === '1') continue;
      if (el.id === 'cookie-popup' && !hideConsentChrome) {
        const text = (el.innerText || '').trim();
        if (text.length >= 12) continue;
      }
      if (!isBlockingDimmer(el, view) && el.dataset?.gafTestDimmer !== '1') continue;
      if (hideDimmer(el)) cleared += 1;
    }
  }
  try {
    for (const el of doc.body?.children || []) {
      if (seen.has(el)) continue;
      if (el.id?.startsWith?.('gaf-')) continue;
      if (isBlockingDimmer(el, view) || el.dataset?.gafTestDimmer === '1') {
        if (hideDimmer(el)) {
          seen.add(el);
          cleared += 1;
        }
      }
    }
  } catch {
    /* ignore */
  }

  if (hideConsentChrome) {
    for (const sel of ['#cookie-popup', '[aria-modal="true"]', '[role="dialog"]']) {
      let nodes;
      try {
        nodes = doc.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (!isConsentLikePanel(el) && el.id !== 'cookie-popup') continue;
        if (hideDimmer(el)) {
          cleared += 1;
          // Walk parents that are fixed full-screen consent stacks
          let p = el.parentElement;
          let depth = 0;
          while (p && p !== doc.body && depth < 5) {
            if (isBlockingDimmer(p, view) || p.getAttribute?.('aria-modal') === 'true') {
              hideDimmer(p);
            }
            p = p.parentElement;
            depth += 1;
          }
        }
      }
    }
  }
  return cleared;
}

/** Named adapter host for Hyvä cookie_consent seeding. */
export function isDiturConsentHost(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '');
  return h === 'ditur.no' || h.endsWith('.ditur.no');
}

/**
 * Seed a minimal cookie_consent cookie so Hyvä/ditur shouldDisplay() stays closed.
 * Matches the shape createConsentObject() writes (necessary only).
 * Only runs on ditur.no — not a global fallback.
 */
export function seedMinimalConsentCookie(doc, view = globalThis) {
  const win = view.defaultView || view || globalThis;
  const host = win.location?.hostname || '';
  if (!isDiturConsentHost(host)) return false;
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      consent_domain: win.location?.hostname || 'www.ditur.no',
      cookie_consent_id: 'gaf' + Math.random().toString(36).slice(2, 12),
      consents_approved: ['cookie_cat_necessary'],
      consents_denied: [
        'cookie_cat_unclassified',
        'cookie_cat_functional',
        'cookie_cat_statistic',
        'cookie_cat_marketing',
      ],
    };
    const value = encodeURIComponent(JSON.stringify(payload));
    const maxAge = 14 * 24 * 60 * 60;
    const host = win.location?.hostname || '';
    doc.cookie = `cookie_consent=${value}; path=/; max-age=${maxAge}; samesite=lax`;
    if (host) {
      doc.cookie = `cookie_consent=${value}; path=/; max-age=${maxAge}; samesite=lax; domain=${host}`;
    }
    return true;
  } catch {
    return false;
  }
}

/** Explicit force still cannot make an ambiguous consent decision. */
export function forceUncoverInteractionLock(doc, view = globalThis) {
  const consent = dismissBlockingConsentWall(doc, view);
  return {
    cleared: 0, unlocked: consent.unlocked, seeded: false,
    reason: consent.dismissed ? 'consent-dismissed' : 'consent-awaiting-user',
    consent,
  };
}

/**
 * True if the page still looks interaction-locked (caller may keep retrying).
 */
export function isInteractionLocked(doc, view = globalThis) {
  return isPageScrollLocked(doc) || hasBlockingDimmer(doc, view);
}

/**
 * Clear interaction blockers: page-locking consent walls, then orphan dimmers.
 * @returns {{ cleared: number, unlocked: boolean, reason: string, consent?: object }}
 */
export function unstickOrphanedOverlays(doc, view = globalThis, options = {}) {
  const result = { cleared: 0, unlocked: false, reason: 'noop' };
  if (!doc?.querySelectorAll) return result;

  // Payment-auth first: never click-accept or hide BankID/Morrow even if the
  // challenge mentions personvern or sits in an empty-looking iframe overlay.
  if (documentHasPaymentAuth(doc)) {
    result.reason = 'payment-auth-present';
    return result;
  }

  const locked = isPageScrollLocked(doc);
  const dimmer = hasBlockingDimmer(doc, view);
  const force = Boolean(options.force);

  // 1) Cookie wall: locked body and/or grey + consent UI → click accept
  if (locked || dimmer || force) {
    const consent = dismissBlockingConsentWall(doc, view);
    if (consent.dismissed) {
      result.cleared = hideBlockingDimmers(doc, view, new Set());
      result.unlocked = unlockBodyScroll(doc) || consent.unlocked;
      result.consent = { button: consent.button, kind: consent.kind };
      result.reason = 'consent-dismissed';
      return result;
    }

    // Keep unresolved consent visible. Neither force mode nor a failed click
    // authorizes acceptance, cookie seeding, or hiding the user's choices.
    if (hasConsentLikeVisible(doc, view)) {
      result.reason = 'consent-awaiting-user';
      return result;
    }
  }

  // 2) Usable non-consent modal (login / cart / filters / app settings) → leave alone.
  // force is for Alpine re-lock loops on real cookie walls only — never destroy app UI.
  if (hasUsableModalContent(doc, view) && !isConsentOnlyLock(doc, view)) {
    result.reason = 'usable-modal-present';
    return result;
  }

  // 3) Orphan dimmers with no usable dialog
  result.cleared = hideBlockingDimmers(doc, view, new Set());
  result.unlocked = unlockBodyScroll(doc);
  result.reason = result.cleared > 0 || result.unlocked ? 'cleared' : 'none-found';
  return result;
}

function hasConsentLikeVisible(doc, view) {
  const win = view.defaultView || view;
  const getStyle = view.getComputedStyle || win?.getComputedStyle?.bind(win);
  for (const sel of CONSENT_ROOT_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (isConsentLikePanel(el)) {
        if (el.dataset?.gafTestConsent === '1') return true;
        if (visibleModalLike(el, getStyle) || isPageScrollLocked(doc)) return true;
      }
    }
  }
  return false;
}

/** Consent wall only (not login/cart) while locked. */
function isConsentOnlyLock(doc, view) {
  if (!isPageScrollLocked(doc) && !hasBlockingDimmer(doc, view)) return false;
  return hasConsentLikeVisible(doc, view);
}
