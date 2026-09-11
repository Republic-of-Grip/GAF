/**
 * GAF early interaction unlock — no module imports (cannot fail loadCore chain).
 * Targets the ditur.no / Hyvä pattern:
 *   full-viewport grey veil + transparent click catcher, page frozen.
 *
 * MUST NOT run on video player sites (YouTube fullscreen, etc.):
 * those use fixed full-viewport layers + overflow locks legitimately.
 * Regression: fullscreen went black; Escape left a dead player (0.2.10).
 */
(() => {
  if (window !== window.top) return;
  if (globalThis.__gafUnstickEarly) return;
  globalThis.__gafUnstickEarly = true;

  const STYLE_ID = 'gaf-force-unlock-style';
  /** When false (master off / excluded / settings not loaded), never mutate. */
  let filteringActive = false;

  /** Shop / cookie locks only — not generic overflow-hidden (breaks YT fullscreen). */
  const CONSENT_BODY_LOCKS = ['noscroll', 'phantom-scroll-bar', 'modal-open', 'no-scroll'];

  // Keep aligned with interaction-guard.mjs; never infer what "selected" means.
  const MINIMAL_RE =
    /^(?:necessary only|only necessary|kun n[øo]dvendige?|bare n[øo]dvendige?|avvis alle|reject all|decline all|deny all|refuse all)(?: cookies| informasjonskapsler)?[.!]?$/i;
  // No bare "privacy" — matches app settings text (Grok etc.) and false-unsticks modals
  const CONSENT_RE =
    /cookie|cookies|personvern|consent|samtykke|vi tilpasser|privacy policy|cookie policy|informasjonskapsler|we use cookies|vi bruker cookies/i;

  /**
   * Hosts where full-viewport fixed layers + overflow locks are normal player UI.
   * Keep in sync with settings looksLikePlayerPage / MEDIA_PLAYER_HOST_RE.
   */
  const MEDIA_PLAYER_HOST_RE =
    /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|m\.youtube\.com|music\.youtube\.com|vimeo\.com|player\.vimeo\.com|twitch\.tv|player\.twitch\.tv|netflix\.com|disneyplus\.com|hulu\.com|primevideo\.com|amazon\.[a-z.]+|tv\.apple\.com|play\.hbomax\.com|max\.com|spotify\.com|soundcloud\.com|dailymotion\.com|bilibili\.com|tiktok\.com|rumble\.com|kick\.com)$/i;

  /**
   * Complex SPAs / tools whose modals must never be "unstuck".
   * Keep in sync with settings.mjs TOOL_SPA_HOST_RE.
   * Regression: filterblade.xyz Strictness modal (ModalBox_Outer) was hidden ~500ms after open.
   * Regression: grok.x.ai Account → Usage settings panel disappeared under force unstick.
   * Regression: x.com reply compose — mask treated as orphan grey; clicks hit timeline behind.
   */
  const TOOL_SPA_HOST_RE =
    /(^|\.)(filterblade\.xyz|pathofexile\.com|maxroll\.gg|poe\.ninja|poewiki\.net|overgear\.com|x\.ai|grok\.com|x\.com|twitter\.com)$/i;

  /**
   * BankID / Morrow 3DS — never unstick. Keep in sync with settings.mjs PAYMENT_AUTH_HOST_RE.
   * Regression: Starlink + Morrow card, national-ID/BankID popup hidden as an orphan grey.
   */
  const PAYMENT_AUTH_HOST_RE =
    /(^|\.)(bankid\.no|morrowbank\.no|morrowbank\.com)$/i;

  const PAYMENT_AUTH_TEXT_RE =
    /bankid|morrow\s*bank|f[øo]dselsnummer|nasjonalt\s+identitetsnummer/i;

  function hostNorm() {
    return String(location.hostname || '')
      .toLowerCase()
      .replace(/^www\./, '');
  }

  function isMediaPlayerSite() {
    const h = hostNorm();
    if (!h) return false;
    if (MEDIA_PLAYER_HOST_RE.test(h)) return true;
    const path = location.pathname || '';
    if (/\/(watch|embed|live|player)\b/i.test(path) && document.querySelector('video, ytd-player, #movie_player')) {
      return true;
    }
    return false;
  }

  function isToolSpaSite() {
    return TOOL_SPA_HOST_RE.test(hostNorm());
  }

  function isPaymentAuthSite() {
    return PAYMENT_AUTH_HOST_RE.test(hostNorm());
  }

  function paymentAuthSrc(src) {
    const s = String(src || '').trim();
    if (!s || /^about:blank$/i.test(s) || s.startsWith('javascript:')) return false;
    try {
      const u = new URL(s, location.href);
      const h = String(u.hostname || '')
        .toLowerCase()
        .replace(/^www\./, '');
      if (h && PAYMENT_AUTH_HOST_RE.test(h)) return true;
    } catch {
      /* ignore */
    }
    return /(?:^|[/.])(bankid\.no|morrowbank\.no|morrowbank\.com)(?:[/?#:]|$)/i.test(s);
  }

  function isPaymentAuthLayer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'IFRAME' && paymentAuthSrc(el.getAttribute('src') || el.src)) return true;
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/bankid|morrowbank/i.test(id) || /bankid|morrowbank/i.test(cls)) return true;
    try {
      const frames = el.querySelectorAll?.('iframe');
      if (frames) {
        for (const f of frames) {
          if (paymentAuthSrc(f.getAttribute?.('src') || f.src)) return true;
        }
      }
    } catch {
      /* ignore */
    }
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    return PAYMENT_AUTH_TEXT_RE.test(text);
  }

  function isFullscreenMedia() {
    try {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fs) return false;
      if (fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME') return true;
      if (fs.querySelector?.('video, iframe')) return true;
      if (fs.closest?.('ytd-player, #movie_player, .html5-video-player')) return true;
      return true;
    } catch {
      return false;
    }
  }

  function shouldSkipSite() {
    if (!filteringActive) return true;
    if (isMediaPlayerSite()) return true;
    if (isToolSpaSite()) return true;
    if (isPaymentAuthSite()) return true;
    if (isFullscreenMedia()) return true;
    return false;
  }

  /**
   * Undo inline hides from markAndHideBlockers so turning GAF off does not
   * leave a broken lightbox until refresh (X.com photo viewer regression).
   */
  function restoreUnstickDamage() {
    let n = 0;
    try {
      const nodes = document.querySelectorAll(
        '[data-gaf-blocker="1"], [data-gaf-consent-stack="1"], [data-gaf-unstuck="1"]',
      );
      for (const el of nodes) {
        try {
          el.style.removeProperty('display');
          el.style.removeProperty('pointer-events');
          el.style.removeProperty('opacity');
          el.style.removeProperty('visibility');
        } catch {
          try {
            el.style.display = '';
            el.style.pointerEvents = '';
            el.style.opacity = '';
            el.style.visibility = '';
          } catch {
            /* ignore */
          }
        }
        el.removeAttribute('data-gaf-blocker');
        el.removeAttribute('data-gaf-consent-stack');
        el.removeAttribute('data-gaf-unstuck');
        n += 1;
      }
    } catch {
      /* ignore */
    }
    try {
      document.documentElement.classList.remove('gaf-force-unlock');
    } catch {
      /* ignore */
    }
    try {
      document.getElementById(STYLE_ID)?.remove();
    } catch {
      /* ignore */
    }
    return n;
  }

  function setFilteringActive(active) {
    filteringActive = active !== false;
    if (!filteringActive) {
      restoreUnstickDamage();
    }
  }

  function refreshEnabledFromStorage() {
    try {
      chrome.storage.local.get({ gafSettings: null, gafExclusions: [] }, (localData) => {
        const apply = (settings) => {
          const s = settings && typeof settings === 'object' ? settings : {};
          let host = '';
          try {
            host = hostNorm();
          } catch {
            host = '';
          }
          const exclusions = Array.isArray(localData?.gafExclusions) ? localData.gafExclusions : [];
          const excluded = exclusions.some((e) => {
            if (!e || (e.status !== 'open' && e.status !== 'reviewing')) return false;
            const h = String(e.host || '')
              .toLowerCase()
              .replace(/^www\./, '');
            return h && (host === h || host.endsWith(`.${h}`));
          });
          const deny = Array.isArray(s.denyHosts)
            ? s.denyHosts.some((d) => {
                const h = String(d || '')
                  .toLowerCase()
                  .replace(/^www\./, '');
                return h && (host === h || host.endsWith(`.${h}`));
              })
            : false;
          // Match resolveSitePolicy: master off → inactive; deny beats exclusion
          const active = s.enabled !== false && (deny || !excluded);
          setFilteringActive(active);
        };
        const localSettings = localData?.gafSettings;
        if (localSettings && typeof localSettings === 'object' && Object.keys(localSettings).length) {
          apply(localSettings);
          return;
        }
        try {
          chrome.storage.sync.get({ gafSettings: null }, (syncData) => {
            apply(syncData?.gafSettings || { enabled: true });
          });
        } catch {
          apply({ enabled: true });
        }
      });
    } catch {
      /* ignore */
    }
  }

  function isAppModal(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/ModalBox|modal-box|MuiModal|ReactModal|chakra-modal/i.test(cls)) return true;
    if (el.closest?.('.ModalBox_Outer, .ModalBox_Container, [class*="ModalBox"]')) return true;
    return false;
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-gaf', 'force-unlock');
    // Do NOT force body.overflow-hidden unlock — many apps (YouTube) need it.
    style.textContent = `
html.gaf-force-unlock body.noscroll,
html.gaf-force-unlock body.phantom-scroll-bar,
html.gaf-force-unlock body.modal-open,
html.gaf-force-unlock body.no-scroll {
  overflow: auto !important;
  position: static !important;
  top: auto !important;
  left: auto !important;
  right: auto !important;
}
html.gaf-force-unlock #cookie-popup,
html.gaf-force-unlock #ditur-popup-container,
html.gaf-force-unlock #ditur-popup-overlay,
html.gaf-force-unlock #confirmOverlay,
html.gaf-force-unlock [data-gaf-consent-stack="1"],
html.gaf-force-unlock .bg-gray-500\\/75,
html.gaf-force-unlock [class*="bg-gray-500/75"],
html.gaf-force-unlock [class*="bg-opacity-50"][class*="fixed"] {
  display: none !important;
  pointer-events: none !important;
  opacity: 0 !important;
  visibility: hidden !important;
}
html.gaf-force-unlock [data-gaf-blocker="1"] {
  display: none !important;
  pointer-events: none !important;
}
`.trim();
    (document.head || document.documentElement).appendChild(style);
  }

  function unlockBody() {
    const body = document.body;
    if (!body) return false;
    let changed = false;
    for (const cls of CONSENT_BODY_LOCKS) {
      if (body.classList.contains(cls)) {
        body.classList.remove(cls);
        changed = true;
      }
    }
    // Only clear inline locks that Hyvä sets with noscroll (top offset), not all overflow
    if (body.classList.contains('noscroll') === false && body.style.position === 'fixed') {
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      changed = true;
    }
    if (body.style.overflow === 'hidden' && hasConsentSignal()) {
      body.style.overflow = '';
      body.style.overflowY = '';
      changed = true;
    }
    return changed;
  }

  function hasConsentSignal() {
    if (document.querySelector('#cookie-popup, #ditur-popup-content, #ditur-popup-container')) {
      return true;
    }
    const text = (document.body?.innerText || '').slice(0, 4000);
    if (CONSENT_RE.test(text) && (MINIMAL_RE.test(text) || FULL_RE.test(text))) return true;
    return false;
  }

  function hasConsentGreyScrim() {
    const iw = window.innerWidth || 0;
    const ih = window.innerHeight || 0;
    for (const el of document.querySelectorAll('body *')) {
      let st;
      try {
        st = getComputedStyle(el);
      } catch {
        continue;
      }
      if (st.position !== 'fixed' || st.display === 'none' || st.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < iw * 0.85 || r.height < ih * 0.85) continue;
      const cls = String(el.className || '');
      if (/bg-gray-500|bg-opacity-50/i.test(cls)) return true;
      const bg = st.backgroundColor || '';
      // mid-grey scrims like rgba(107, 114, 128, 0.75) — not pure black player chrome
      const m = bg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (m) {
        const r0 = parseFloat(m[1]);
        const g0 = parseFloat(m[2]);
        const b0 = parseFloat(m[3]);
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
        if (a > 0.2 && a < 0.95 && r0 > 60 && r0 < 180 && Math.abs(r0 - g0) < 40 && Math.abs(g0 - b0) < 40) {
          return true;
        }
      }
    }
    return false;
  }

  function clickConsentButtons() {
    const roots = document.querySelectorAll('#cookie-popup, #ditur-popup-content, [role="dialog"], [aria-modal="true"]');
    const buttons = [];
    for (const root of roots) {
      if (!CONSENT_RE.test(root.innerText || root.textContent || '')) continue;
      buttons.push(...root.querySelectorAll('button, [role="button"], a.button, input[type="button"], input[type="submit"]'));
    }
    let minimal = null;
    for (const btn of buttons) {
      if (btn.disabled) continue;
      const t = (btn.innerText || btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 80) continue;
      if (MINIMAL_RE.test(t) && !minimal) minimal = btn;
    }
    const hit = minimal;
    if (!hit) return null;

    const token = `g${Math.random().toString(36).slice(2, 10)}`;
    try {
      hit.setAttribute('data-gaf-consent-target', token);
    } catch {
      /* ignore */
    }
    const selector = `[data-gaf-consent-target="${token}"]`;
    try {
      window.postMessage({ source: 'gaf-extension', type: 'GAF_PAGE_CLICK', selector }, '*');
      return (hit.innerText || '').trim();
    } catch {
      try {
        hit.removeAttribute('data-gaf-consent-target');
      } catch {
        /* ignore */
      }
    }
    try {
      hit.click();
      return (hit.innerText || '').trim();
    } catch {
      return null;
    }
  }

  function isMediaElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'IFRAME' || tag === 'CANVAS') return true;
    if (el.id === 'movie_player' || el.classList?.contains?.('html5-video-player')) return true;
    if (typeof el.closest === 'function') {
      if (
        el.closest(
          'video, audio, ytd-player, #movie_player, .html5-video-player, .ytp-fullscreen, [class*="video-player"]',
        )
      ) {
        return true;
      }
    }
    if (el.querySelector?.('video, audio, .html5-main-video')) return true;
    return false;
  }

  function markAndHideBlockers() {
    const iw = window.innerWidth || 0;
    const ih = window.innerHeight || 0;
    if (iw < 100 || ih < 100) return 0;
    let n = 0;
    // Only hide greys when we have a real consent signal — never generic app modals
    const consentSignal = hasConsentSignal();
    if (!consentSignal) return 0;

    for (const el of document.querySelectorAll('body *')) {
      if (isMediaElement(el)) continue;
      if (isAppModal(el)) continue;
      if (isPaymentAuthLayer(el)) continue;
      const tag = el.tagName;
      if (tag === 'MAIN' || tag === 'ARTICLE' || tag === 'HEADER' || tag === 'NAV') continue;
      const earlyId = el.id || '';
      if (/^nav[-_]?backdrop$/i.test(earlyId) || earlyId === 'cookie-banner' || earlyId === 'cookie-form') {
        continue;
      }
      try {
        const hosted = el.querySelector?.('video, canvas');
        if (hosted) {
          const vr = hosted.getBoundingClientRect();
          if (vr.width >= iw * 0.45 && vr.height >= ih * 0.35) continue;
        }
      } catch {
        /* ignore */
      }
      let st;
      try {
        st = getComputedStyle(el);
      } catch {
        continue;
      }
      if (!st) continue;
      if (st.position !== 'fixed' && st.position !== 'absolute') continue;
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (st.pointerEvents === 'none') continue;
      let r;
      try {
        r = el.getBoundingClientRect();
      } catch {
        continue;
      }
      if (r.width < iw * 0.8 || r.height < ih * 0.8) continue;

      const cls = typeof el.className === 'string' ? el.className : '';
      const id = el.id || '';
      if (/(^|\s)bg-image-overlay(\s|$)/i.test(cls)) continue;
      const opacity = parseFloat(st.opacity);
      if (Number.isFinite(opacity) && opacity < 0.05) continue;
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      // Content-rich fixed layers are UI, not orphan greys (FilterBlade Strictness modal)
      if (text.length >= 24) continue;
      if (el.querySelector?.('button, a, input, select, textarea, [role="button"]') && text.length >= 8) {
        continue;
      }

      const bg = st.backgroundColor || '';
      const alpha = (() => {
        if (!bg || bg === 'transparent') return 0;
        const m = bg.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/);
        if (m) return parseFloat(m[1]);
        const m2 = bg.match(/\/\s*([\d.]+)\s*\)/);
        if (m2) return parseFloat(m2[1]);
        if (bg.startsWith('rgb(') && !bg.includes('rgba')) return 1;
        return 0;
      })();

      if (alpha > 0.9) {
        const m = bg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
        if (m && parseFloat(m[1]) < 20 && parseFloat(m[2]) < 20 && parseFloat(m[3]) < 20) {
          continue;
        }
      }

      const isGrey =
        (alpha > 0.05 && alpha < 0.95) ||
        /bg-gray-500|bg-opacity-50/i.test(cls) ||
        id === 'confirmOverlay' ||
        id === 'ditur-popup-overlay';
      const isConsentChrome =
        id === 'cookie-popup' ||
        id === 'ditur-popup-container' ||
        (el.getAttribute('aria-modal') === 'true' && CONSENT_RE.test(text)) ||
        (el.getAttribute('role') === 'dialog' && CONSENT_RE.test(text));
      const isTransparentCatcher = alpha <= 0.05;

      if (!isGrey && !isConsentChrome && !isTransparentCatcher) continue;

      el.setAttribute('data-gaf-blocker', '1');
      if (isConsentChrome) el.setAttribute('data-gaf-consent-stack', '1');
      try {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        el.style.setProperty('opacity', '0', 'important');
      } catch {
        /* ignore */
      }
      n += 1;
    }
    return n;
  }

  /**
   * Only true for shop/consent freeze patterns — not YouTube overflow + player chrome.
   */
  function looksLocked() {
    if (shouldSkipSite()) return false;
    const consent = hasConsentSignal();
    if (!consent) return false;
    if (hasConsentGreyScrim()) return true;
    if (document.querySelector('#cookie-popup, #ditur-popup-container')) return true;
    if (
      document.body?.classList?.contains?.('noscroll') ||
      document.body?.classList?.contains?.('phantom-scroll-bar')
    ) {
      return true;
    }
    return false;
  }

  function forceUnlock(reason) {
    if (shouldSkipSite()) return { reason: 'skipped-media', btn: null, hidden: 0 };
    const btn = clickConsentButtons();
    if (!btn) return { reason: 'consent-awaiting-user', btn: null, hidden: 0 };
    injectCss();
    document.documentElement.classList.add('gaf-force-unlock');
    const hidden = markAndHideBlockers();
    unlockBody();
    setTimeout(() => {
      if (shouldSkipSite() || !looksLocked()) return;
      clickConsentButtons();
      markAndHideBlockers();
      unlockBody();
    }, 100);
    setTimeout(() => {
      if (shouldSkipSite()) return;
      markAndHideBlockers();
      unlockBody();
    }, 500);
    return { reason, btn, hidden };
  }

  function tick() {
    try {
      if (shouldSkipSite()) return false;
      if (!document.body) return false;
      if (!looksLocked()) {
        if (document.documentElement.classList.contains('gaf-force-unlock') && hasConsentSignal()) {
          markAndHideBlockers();
          unlockBody();
        }
        return false;
      }
      forceUnlock('early-tick');
      return true;
    } catch {
      return false;
    }
  }

  // Media players: install no-op hooks only
  if (isMediaPlayerSite()) {
    globalThis.__gafForceUnlock = () => ({ reason: 'skipped-media' });
    globalThis.__gafRestoreUnstick = () => 0;
    globalThis.__gafUnstickSetActive = () => {};
    return;
  }

  refreshEnabledFromStorage();
  try {
    chrome.storage.onChanged.addListener(() => refreshEnabledFromStorage());
  } catch {
    /* ignore */
  }

  const delays = [0, 200, 500, 900, 1400, 2000, 3000, 5000, 8000, 12000];
  for (const d of delays) {
    setTimeout(tick, d);
  }

  const startObserver = () => {
    if (!document.documentElement) return;
    let scheduled = false;
    const obs = new MutationObserver(() => {
      if (scheduled || shouldSkipSite()) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        tick();
      }, 80);
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  };

  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  document.addEventListener('fullscreenchange', () => {
    // Leave fullscreen media alone; clear force class if we wrongly applied on this tab
    if (isFullscreenMedia()) {
      document.documentElement.classList.remove('gaf-force-unlock');
    }
  });

  globalThis.__gafForceUnlock = () => {
    if (!filteringActive || shouldSkipSite()) return { reason: 'skipped' };
    return forceUnlock('manual');
  };
  globalThis.__gafRestoreUnstick = restoreUnstickDamage;
  globalThis.__gafUnstickSetActive = setFilteringActive;
})();
