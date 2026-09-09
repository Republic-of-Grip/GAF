/**
 * GAF early bootstrap (document_start, isolated world).
 * Injects CSS motion + element-hide ASAP; pushes time-freeze config to MAIN world.
 */
(() => {
  const MOTION_ID = 'gaf-motion-style';
  const HIDE_ID = 'gaf-element-hide-style';
  const PREVIEW_ID = 'gaf-preview-video-early';

  // Keep in sync with src/core/css-motion.mjs MODERATE_CSS / STRICT_CSS / INTERACTIVE_UI_PROTECT_CSS
  // Do not revert opacity/visibility/transform/pointer-events here — unlayered
  // revert-layer forces UA visible defaults and unhides closed POWER.no dialogs.
  const INTERACTIVE_UI_PROTECT_CSS = `
html.gaf-motion-active dialog,
html.gaf-motion-active dialog *,
html.gaf-motion-active dialog *::before,
html.gaf-motion-active dialog *::after,
html.gaf-motion-active [role="dialog"],
html.gaf-motion-active [role="dialog"] *,
html.gaf-motion-active [role="dialog"] *::before,
html.gaf-motion-active [role="dialog"] *::after,
html.gaf-motion-active [role="overlay"],
html.gaf-motion-active [role="overlay"] *,
html.gaf-motion-active [role="overlay"] *::before,
html.gaf-motion-active [role="overlay"] *::after,
html.gaf-motion-active [aria-modal="true"],
html.gaf-motion-active [aria-modal="true"] *,
html.gaf-motion-active [aria-modal="true"] *::before,
html.gaf-motion-active [aria-modal="true"] *::after,
html.gaf-motion-active .backdrop,
html.gaf-motion-active .backdrop *,
html.gaf-motion-active #nav-backdrop,
html.gaf-motion-active #nav-backdrop *,
html.gaf-motion-active [id$="-backdrop"],
html.gaf-motion-active [id$="-backdrop"] *,
html.gaf-motion-active .bg-image-overlay,
html.gaf-motion-active .bg-image-overlay *,
html.gaf-motion-active #cookie-banner,
html.gaf-motion-active #cookie-banner *,
html.gaf-motion-active #cookie-form,
html.gaf-motion-active #cookie-form *,
html.gaf-motion-active #cookie-popup,
html.gaf-motion-active #cookie-popup *,
html.gaf-motion-active #authentication-popup,
html.gaf-motion-active #authentication-popup *,
html.gaf-motion-active #ditur-popup-container,
html.gaf-motion-active #ditur-popup-container *,
html.gaf-motion-active #confirmOverlay,
html.gaf-motion-active #confirmOverlay *,
html.gaf-motion-active #confirmBox,
html.gaf-motion-active #confirmBox *,
html.gaf-motion-active #diturelastic-filters,
html.gaf-motion-active #diturelastic-filters *,
html.gaf-motion-active iframe[src*="bankid.no"],
html.gaf-motion-active iframe[src*="morrowbank.no"],
html.gaf-motion-active iframe[src*="morrowbank.com"] {
  animation-duration: revert-layer !important;
  animation-iteration-count: revert-layer !important;
  animation-delay: revert-layer !important;
  animation-play-state: running !important;
  transition-duration: revert-layer !important;
  transition-delay: revert-layer !important;
}
`.trim();

  const MODERATE_CSS = `
html.gaf-motion-active *,
html.gaf-motion-active *::before,
html.gaf-motion-active *::after {
  scroll-behavior: auto !important;
}
html.gaf-motion-active *:not(img):not(picture):not(video):not(source):not(canvas),
html.gaf-motion-active *:not(img):not(picture):not(video):not(source):not(canvas)::before,
html.gaf-motion-active *:not(img):not(picture):not(video):not(source):not(canvas)::after {
  animation-iteration-count: 1 !important;
}
html.gaf-motion-active img,
html.gaf-motion-active picture,
html.gaf-motion-active video,
html.gaf-motion-active canvas,
html.gaf-motion-active svg image {
  animation-duration: revert-layer !important;
  animation-iteration-count: revert-layer !important;
  animation-delay: revert-layer !important;
  animation-play-state: running !important;
  transition-duration: revert-layer !important;
  transition-delay: revert-layer !important;
  opacity: revert-layer !important;
  visibility: revert-layer !important;
}
${INTERACTIVE_UI_PROTECT_CSS}
`.trim();

  const STRICT_CSS = `
html.gaf-motion-active *,
html.gaf-motion-active *::before,
html.gaf-motion-active *::after {
  animation-duration: 0.001ms !important;
  animation-iteration-count: 1 !important;
  animation-delay: 0s !important;
  transition-duration: 0.001ms !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
html.gaf-motion-active img,
html.gaf-motion-active picture,
html.gaf-motion-active video,
html.gaf-motion-active canvas {
  animation: none !important;
  transition: none !important;
  opacity: 1 !important;
  visibility: visible !important;
}
${INTERACTIVE_UI_PROTECT_CSS}
`.trim();

  // Early kill for news teaser loops (vg.no <preview-video>) — poster sibling stays.
  // Full freeze still runs in freeze-media; this reduces autoplay flash before idle.
  const PREVIEW_VIDEO_EARLY_CSS = `
preview-video{display:none!important;visibility:hidden!important;pointer-events:none!important;opacity:0!important}
preview-video+img,.preview-video-loaded+img,.preview-video-in-screen+img{opacity:1!important;visibility:visible!important}
`.trim();

  // Keep aligned with settings.DEFAULT_HIDE_RULES — never bare [class*="paywall"]
  // (Schibsted marks article body with class "paywall").
  const DEFAULT_HIDE = [
    '[class*="paywall-modal" i]',
    '[class*="paywall-overlay" i]',
    '[class*="paywall-backdrop" i]',
    '[class*="paywall-gate" i]',
    '[class*="paywall-curtain" i]',
    '[id*="paywall-modal" i]',
    '[id*="paywall-overlay" i]',
    '[data-testid*="paywall" i]',
    '[data-testid*="regwall" i]',
    '[class*="regwall-modal" i]',
    '[class*="RegWall" i]',
    '[id*="regwall" i]',
    '[class*="soft-wall" i]',
    '[class*="SoftWall" i]',
    '[class*="piano-offer" i]',
    '.tp-modal',
    '.tp-backdrop',
    '.tp-iframe-wrapper',
    '[class*="subscription-wall" i]',
    '[class*="subscribe-wall" i]',
    // Free-article gate chrome (Spiked) — not bare [class*="paywall"]
    '.gated-content-wrap.paywall',
    '.gated-content-notice',
  ];

  function cssForLevel(level) {
    if (level === 'strict') return STRICT_CSS;
    if (level === 'moderate') return MODERATE_CSS;
    return '';
  }

  function normalizeHost(hostname) {
    return String(hostname || '')
      .toLowerCase()
      .replace(/^www\./, '');
  }

  function hostMatches(list, host) {
    if (!host || !Array.isArray(list)) return false;
    return list.some((h) => {
      const n = normalizeHost(typeof h === 'string' ? h : h?.host);
      return n && (host === n || host.endsWith(`.${n}`));
    });
  }

  // Keep in sync with settings.mjs GAME_PUZZLE_PATH_RE / looksLikeGameOrPuzzlePage
  const GAME_PUZZLE_PATH_RE =
    /\/(games?|puzzles?|crosswords?(?:-puzzles?)?|wordle|connections|strands|spelling-bee|sudoku|letter-boxed|tiles|queens|interactive|quizzes?|trivia)(\/|$|[-_])/i;

  function looksLikeGameOrPuzzlePath(pathname, hostname) {
    const host = normalizeHost(hostname);
    if (/^games?\./.test(host) || host.startsWith('puzzles.')) return true;
    return GAME_PUZZLE_PATH_RE.test(pathname || '/');
  }

  // Keep in sync with settings.mjs MEDIA_PLAYER_HOST_RE
  const MEDIA_PLAYER_HOST_RE =
    /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|music\.youtube\.com|vimeo\.com|player\.vimeo\.com|twitch\.tv|player\.twitch\.tv|netflix\.com|disneyplus\.com|hulu\.com|primevideo\.com|tv\.apple\.com|max\.com|spotify\.com|soundcloud\.com|dailymotion\.com|tiktok\.com|rumble\.com|kick\.com)$/i;

  // Keep in sync with settings.mjs TOOL_SPA_HOST_RE
  // x.com/twitter: compose/reply mask must not get CSS motion kill (see settings.mjs)
  const TOOL_SPA_HOST_RE =
    /(^|\.)(filterblade\.xyz|pathofexile\.com|maxroll\.gg|poe\.ninja|poewiki\.net|overgear\.com|x\.ai|grok\.com|x\.com|twitter\.com)$/i;

  // Keep in sync with settings.mjs PAYMENT_AUTH_HOST_RE
  const PAYMENT_AUTH_HOST_RE =
    /(^|\.)(bankid\.no|morrowbank\.no|morrowbank\.com)$/i;

  function isMediaPlayerHost(hostname) {
    return MEDIA_PLAYER_HOST_RE.test(normalizeHost(hostname));
  }

  function isToolSpaHost(hostname) {
    return TOOL_SPA_HOST_RE.test(normalizeHost(hostname));
  }

  function isPaymentAuthHost(hostname) {
    return PAYMENT_AUTH_HOST_RE.test(normalizeHost(hostname));
  }

  function ensureStyle(id, css) {
    const root = document.documentElement;
    if (!root) return;
    let el = document.getElementById(id);
    if (!css) {
      el?.remove();
      if (id === MOTION_ID) root.classList?.remove('gaf-motion-active');
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      el.setAttribute('data-gaf', id);
      (document.head || root).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
    if (id === MOTION_ID) root.classList.add('gaf-motion-active');
  }

  function buildHideCss(selectors) {
    return (selectors || [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map(
        (sel) =>
          `${sel.replace(/[{}]/g, '')}{display:none!important;visibility:hidden!important;pointer-events:none!important;}`
      )
      .join('\n');
  }

  function postTimeFreeze(cfg) {
    try {
      window.postMessage({ source: 'gaf-extension', ...cfg }, '*');
      window.dispatchEvent(new CustomEvent('gaf-time-freeze-config', { detail: cfg }));
    } catch {
      /* ignore */
    }
  }

  function postPreviewVideoConfig({ enabled, videoPolicy, host }) {
    // Kill VG/Schibsted <preview-video> teaser loops unless master off / video off / player host
    const kill =
      enabled !== false &&
      videoPolicy !== 'off' &&
      !isMediaPlayerHost(host);
    try {
      window.postMessage(
        {
          source: 'gaf-extension',
          type: 'GAF_PREVIEW_VIDEO_CONFIG',
          killPreviewVideo: kill,
          enabled: enabled !== false,
          videoPolicy: videoPolicy || 'heuristic',
        },
        '*'
      );
    } catch {
      /* ignore */
    }
  }

  function applyBundle(settings, exclusionHosts) {
    const s = settings || {};
    let host = '';
    try {
      host = normalizeHost(location.hostname);
    } catch {
      host = '';
    }

    const denied = hostMatches(s.denyHosts, host);
    const excluded =
      !denied &&
      (hostMatches(s.allowHosts, host) || hostMatches(exclusionHosts, host));
    const active = s.enabled !== false && !excluded;

    if (!active) {
      ensureStyle(MOTION_ID, '');
      ensureStyle(HIDE_ID, '');
      ensureStyle(PREVIEW_ID, '');
      postTimeFreeze({ type: 'GAF_TIME_FREEZE_CONFIG', enabled: false, mode: 'off', factor: 1, minMs: 2000 });
      postPreviewVideoConfig({ enabled: false, videoPolicy: 'off', host });
      return;
    }

    // YouTube / streaming: CSS motion kill breaks fullscreen (black player)
    // FilterBlade etc.: CSS motion + unstick break modals (strictness snaps back)
    const motion = s.motionLevel || 'moderate';
    const skipMotion =
      motion === 'off' || isMediaPlayerHost(host) || isToolSpaHost(host) || isPaymentAuthHost(host);
    ensureStyle(MOTION_ID, skipMotion ? '' : cssForLevel(motion));

    // Teaser loops (vg.no <preview-video>) — skip on dedicated player hosts
    const videoPolicy = s.videoPolicy || 'heuristic';
    const freezePreview =
      videoPolicy !== 'off' && !isMediaPlayerHost(host);
    ensureStyle(PREVIEW_ID, freezePreview ? PREVIEW_VIDEO_EARLY_CSS : '');
    postPreviewVideoConfig({ enabled: true, videoPolicy, host });

    if (s.elementHiding !== false) {
      const user = Array.isArray(s.hideRules) ? s.hideRules : [];
      const useDef = s.useDefaultHideRules !== false;
      const sels = useDef ? DEFAULT_HIDE.concat(user) : user;
      ensureStyle(HIDE_ID, buildHideCss(sels));
    } else {
      ensureStyle(HIDE_ID, '');
    }

    const mode = s.timeFreezeMode || 'slow';
    const factor = Number(s.timeFreezeSlowFactor) || 80;
    const minMs = Number(s.timeFreezeMinMs);
    const scope = s.timeFreezeScope || 'softwall';
    const softHosts = Array.isArray(s._softwallHostsResolved)
      ? s._softwallHostsResolved
      : [];
    const onSoftwall = hostMatches(softHosts, host) || hostMatches(s.softwallHosts, host);
    let path = '/';
    try {
      path = location.pathname || '/';
    } catch {
      path = '/';
    }
    // Games/puzzles use multi-second UX timers — never stretch (see Wordle win toast).
    const isGame = looksLikeGameOrPuzzlePath(path, host);
    const tfEnabled =
      !isGame &&
      !isPaymentAuthHost(host) &&
      (mode === 'slow' || mode === 'stop') &&
      (scope === 'all' || onSoftwall);

    postTimeFreeze({
      type: 'GAF_TIME_FREEZE_CONFIG',
      mode: tfEnabled ? mode : 'off',
      factor: mode === 'stop' ? Math.max(factor, 200) : factor,
      minMs: Number.isFinite(minMs) ? minMs : 2000,
      enabled: tfEnabled,
    });
  }

  // Inert until authoritative settings arrive. Optimistic enable raced
  // customElements.define and painted hide/motion CSS onto OFF/excluded hosts.
  // preview-video-main.js and time-freeze-main.js already start disabled.

  const BUILTIN_SOFTWALL = [
    'telegraph.co.uk',
    'nytimes.com',
    'washingtonpost.com',
    'ft.com',
    'wsj.com',
    'bloomberg.com',
    'theatlantic.com',
    'newyorker.com',
    'wired.com',
    'medium.com',
    'independent.co.uk',
    'economist.com',
    'latimes.com',
    'bostonglobe.com',
    'spiked-online.com',
  ];

  function finishLoad(rawSettings, localData) {
    const settings = { ...(rawSettings && typeof rawSettings === 'object' ? rawSettings : {}) };
    // Default master switch ON when never saved (matches DEFAULT_SETTINGS)
    if (settings.enabled === undefined) settings.enabled = true;
    const useDef = settings.useDefaultSoftwallHosts !== false;
    const extra = Array.isArray(settings.softwallHosts) ? settings.softwallHosts : [];
    settings._softwallHostsResolved = useDef
      ? BUILTIN_SOFTWALL.concat(extra)
      : extra;
    const exclusions = Array.isArray(localData?.gafExclusions)
      ? localData.gafExclusions
      : [];
    const hosts = exclusions
      .filter((e) => e && (e.status === 'open' || e.status === 'reviewing'))
      .map((e) => e.host);
    applyBundle(settings, hosts);
  }

  function loadAll() {
    try {
      // Local-first (same as storage.mjs) — Helium sync is unreliable for unpacked
      chrome.storage.local.get({ gafSettings: null, gafExclusions: [] }, (localData) => {
        const localSettings = localData?.gafSettings;
        if (localSettings && typeof localSettings === 'object' && Object.keys(localSettings).length) {
          finishLoad(localSettings, localData);
          return;
        }
        chrome.storage.sync.get({ gafSettings: null }, (syncData) => {
          const syncSettings = syncData?.gafSettings;
          if (syncSettings && typeof syncSettings === 'object') {
            // Migrate sync → local so popup saves stick
            try {
              chrome.storage.local.set({ gafSettings: syncSettings });
            } catch {
              /* ignore */
            }
            finishLoad(syncSettings, localData);
            return;
          }
          finishLoad({ enabled: true }, localData);
        });
      });
    } catch {
      /* ignore */
    }
  }

  loadAll();

  try {
    chrome.storage.onChanged.addListener(() => loadAll());
  } catch {
    /* ignore */
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'GAF_SETTINGS') {
        loadAll();
      }
      if (message?.type === 'GAF_TIME_FREEZE_CONFIG') {
        postTimeFreeze(message);
      }
    });
  } catch {
    /* ignore */
  }
})();
