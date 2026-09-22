/**
 * GAF settings schema and helpers.
 *
 * Philosophy:
 * - Features ON by default; exclude sites when something breaks.
 * - Exclusions are review backlog items (not silent forever-allow).
 * - Schema versioned for safe upgrades.
 */

export const STORAGE_KEY = 'gafSettings';
export const EXCLUSIONS_KEY = 'gafExclusions';
export const ARCHIVE_KEY = 'gafArchive';

/** Built-in hosts where news video stripping is aggressive. */
export const DEFAULT_NEWS_HOSTS = [
  'vg.no',
  'tv2.no',
  'bt.no',
  'nrk.no',
  'dagbladet.no',
  'aftenposten.no',
  'nettavisen.no',
  'abcnyheter.no',
  'cnn.com',
  'bbc.com',
  'bbc.co.uk',
  'nytimes.com',
  'theguardian.com',
  'washingtonpost.com',
  'reuters.com',
  'telegraph.co.uk',
  'ft.com',
  'wsj.com',
  'independent.co.uk',
  'economist.com',
];

/**
 * Hosts where soft-paywall / metered timers are common — time-freeze is most useful.
 * Time-freeze still runs elsewhere when mode is on; this list can drive auto-stop later.
 */
export const DEFAULT_SOFTWALL_HOSTS = [
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
  /** Cookie free-article meters (incognito works → meter reset) */
  'spiked-online.com',
];

/** How meter cookie reset behaves. */
export const METER_RESET_MODES = ['off', 'manual', 'auto'];
/** Which hosts auto meter-reset may target. */
export const METER_RESET_SCOPES = ['softwall', 'all'];

export const VIDEO_POLICIES = ['off', 'news', 'heuristic'];
export const MOTION_LEVELS = ['off', 'moderate', 'strict'];

/**
 * Time freeze:
 * - off: no timer / snapshot intervention
 * - slow: stretch page timers (soft-paywall delay windows last much longer)
 * - stop: stretch heavily + reading snapshot of the page until user thaws / navigates
 */
export const TIME_FREEZE_MODES = ['off', 'slow', 'stop'];

/**
 * Where timer stretch applies:
 * - softwall: only built-in/extra soft-paywall hosts (safe default — does not break local papers' lazy-load)
 * - all: every site (aggressive; can stall below-fold images)
 */
export const TIME_FREEZE_SCOPES = ['softwall', 'all'];

/**
 * Built-in element-hide rules (global). User rules append.
 *
 * IMPORTANT: Do NOT use bare [class*="paywall"] — Schibsted papers (BT, VG, …)
 * mark *article body* paragraphs/figures with class "paywall" for metering.
 * Hiding those removes the story (see bt.no article regression).
 * Target wall *chrome* (modals, overlays, gates), not content markers.
 */
export const DEFAULT_HIDE_RULES = [
  // Paywall / regwall UI chrome only (not content nodes tagged "paywall")
  '[class*="paywall-modal" i]',
  '[class*="paywall-overlay" i]',
  '[class*="paywall-backdrop" i]',
  '[class*="paywall-gate" i]',
  '[class*="paywall-curtain" i]',
  '[class*="paywall-hard" i]',
  '[id*="paywall-modal" i]',
  '[id*="paywall-overlay" i]',
  '[id*="paywall-gate" i]',
  '[data-testid*="paywall" i]',
  '[data-testid*="regwall" i]',
  // Standalone wall roots (avoid class*="regwall" on inline content if any)
  '[class*="regwall-modal" i]',
  '[class*="regwall-overlay" i]',
  '[class*="RegWall" i]',
  '[id*="regwall" i]',
  '[id*="meter" i][class*="wall" i]',
  '[class*="soft-wall" i]',
  '[class*="SoftWall" i]',
  // Piano / Tinypass common chrome
  '[class*="piano-offer" i]',
  '[id*="piano" i][class*="overlay" i]',
  '.tp-modal',
  '.tp-backdrop',
  '.tp-iframe-wrapper',
  '[class*="subscription-wall" i]',
  '[class*="subscribe-wall" i]',
  '[class*="newsletter-modal" i]',
  '[class*="gdpr-banner" i][class*="blocking" i]',
  // Free-article gate chrome (content already in page — Spiked etc.)
  // NOT bare [class*="paywall"] (Schibsted marks article body with "paywall").
  '.gated-content-wrap.paywall',
  '.gated-content-notice',
  // NOTE: do NOT use bare body > div[class*="overlay"] — shop themes (Hyvä)
  // use fixed overlays for cart/auth/filters; hiding chrome but leaving the
  // scrim produces an unclickable grey page (ditur.no). Prefer interaction-guard.
];

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,

  freezeImages: true,
  /** Broader default — exclude sites that break. */
  videoPolicy: 'heuristic',

  newsHosts: [],
  useDefaultNewsHosts: true,

  motionLevel: 'moderate',
  pauseScriptedMotion: true,

  /**
   * Time freeze (soft paywalls / metered articles).
   * Default slow + softwall scope: stretch only on known soft-wall hosts,
   * and only long delays (see timeFreezeMinMs) so lazy-load still works.
   */
  timeFreezeMode: 'slow',
  /** softwall (default) | all */
  timeFreezeScope: 'softwall',
  /** Multiplier for page setTimeout/setInterval delays in slow mode. */
  timeFreezeSlowFactor: 80,
  /**
   * Only stretch timers whose delay is >= this many ms.
   * Short timers (lazy-load, hydration, rAF polyfills) stay real-time.
   * Soft-paywall meters are typically 3–30s+.
   */
  timeFreezeMinMs: 2000,
  /** In stop mode, also take a reading snapshot shortly after load. */
  timeFreezeSnapshot: true,
  /** Delay (ms) after load before capturing snapshot in stop mode. */
  timeFreezeSnapshotDelayMs: 1200,
  useDefaultSoftwallHosts: true,
  softwallHosts: [],

  /**
   * Free-article meter reset (cookie counters — Spiked, etc.).
   * manual (default): popup / context menu clears site cookies + storage and reloads.
   * auto: same when a meter wall is detected on softwall hosts (once per tab load).
   * off: hide the feature actions.
   */
  meterResetEnabled: true,
  /**
   * auto (default): disarm gate chrome automatically; if body still empty, wipe
   * cookies/storage once and reload (Incognito-equivalent, no button).
   * manual: disarm still auto; cookie wipe only via popup/context menu.
   * off: no meter actions (disarm off too unless meterDisarm forced — see meterDisarm).
   */
  meterResetMode: 'auto',
  /** softwall | all — hosts where auto meter handling runs */
  meterResetScope: 'softwall',
  /**
   * Manual reset only. Auto mode always uses meter-names.
   * all: every cookie visible to the page URL (closest to Incognito; may log you out).
   * meter-names: only cookies whose names look like meters (default).
   */
  meterResetCookieMode: 'meter-names',
  /** Manual reset only: clear all localStorage + sessionStorage for this origin. */
  meterResetClearStorage: true,
  /**
   * Manual reset only. Delete IndexedDB databases and Cache Storage.
   * Off by default — options copy must not imply this is included in "storage".
   */
  meterResetClearDurableStorage: false,
  /**
   * Hide free-article gate chrome when the body is already in the DOM
   * (Spiked `.gated-content-wrap.paywall` etc.). On by default — cookie wipe alone
   * is not enough when the server keeps sending an active gate.
   */
  meterDisarm: true,

  /**
   * Legacy simple lists kept for migration.
   * Prefer `exclusions` (local storage) for review backlog.
   */
  denyHosts: [],
  allowHosts: [],

  /** Element hiding ON by default */
  elementHiding: true,
  hideRules: [],
  useDefaultHideRules: true,

  /** Per-host custom CSS ON by default (map may be empty) */
  customCss: true,
  siteCss: {},

  features: {
    elementHiding: true,
    customCss: true,
    timeFreeze: true,
    inspectionArchive: true,
    meterReset: true,
  },

  version: 2,
});

export function normalizeHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .trim();
}

export function parseHostList(text) {
  if (Array.isArray(text)) {
    return [...new Set(text.map(normalizeHost).filter(Boolean))];
  }
  if (typeof text !== 'string') return [];
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map(normalizeHost)
        .filter(Boolean)
    ),
  ];
}

export function hostListToText(list) {
  return (list || []).join('\n');
}

export function hostMatchesList(host, list) {
  const h = normalizeHost(host);
  if (!h || !Array.isArray(list)) return false;
  return list.some((entry) => {
    const n = normalizeHost(typeof entry === 'string' ? entry : entry?.host);
    return n && (h === n || h.endsWith(`.${n}`));
  });
}

export function normalizeSettings(raw) {
  const base = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };

  base.enabled = Boolean(base.enabled);
  base.freezeImages = Boolean(base.freezeImages);
  base.pauseScriptedMotion = Boolean(base.pauseScriptedMotion);
  base.useDefaultNewsHosts = base.useDefaultNewsHosts !== false;
  base.useDefaultSoftwallHosts = base.useDefaultSoftwallHosts !== false;
  base.useDefaultHideRules = base.useDefaultHideRules !== false;
  base.timeFreezeSnapshot = base.timeFreezeSnapshot !== false;
  base.elementHiding = base.elementHiding !== false;
  base.customCss = base.customCss !== false;
  base.meterResetEnabled = base.meterResetEnabled !== false;
  base.meterResetClearStorage = base.meterResetClearStorage !== false;
  base.meterResetClearDurableStorage = Boolean(base.meterResetClearDurableStorage);
  base.meterDisarm = base.meterDisarm !== false;

  if (!VIDEO_POLICIES.includes(base.videoPolicy)) {
    base.videoPolicy = DEFAULT_SETTINGS.videoPolicy;
  }
  if (!MOTION_LEVELS.includes(base.motionLevel)) {
    base.motionLevel = DEFAULT_SETTINGS.motionLevel;
  }
  if (!TIME_FREEZE_MODES.includes(base.timeFreezeMode)) {
    base.timeFreezeMode = DEFAULT_SETTINGS.timeFreezeMode;
  }
  if (!TIME_FREEZE_SCOPES.includes(base.timeFreezeScope)) {
    base.timeFreezeScope = DEFAULT_SETTINGS.timeFreezeScope;
  }
  if (!METER_RESET_MODES.includes(base.meterResetMode)) {
    base.meterResetMode = DEFAULT_SETTINGS.meterResetMode;
  }
  if (!METER_RESET_SCOPES.includes(base.meterResetScope)) {
    base.meterResetScope = DEFAULT_SETTINGS.meterResetScope;
  }
  if (base.meterResetCookieMode !== 'all' && base.meterResetCookieMode !== 'meter-names') {
    base.meterResetCookieMode = DEFAULT_SETTINGS.meterResetCookieMode;
  }

  const factor = Number(base.timeFreezeSlowFactor);
  base.timeFreezeSlowFactor = Number.isFinite(factor)
    ? Math.min(500, Math.max(2, factor))
    : DEFAULT_SETTINGS.timeFreezeSlowFactor;

  const minMs = Number(base.timeFreezeMinMs);
  base.timeFreezeMinMs = Number.isFinite(minMs)
    ? Math.min(60000, Math.max(0, minMs))
    : DEFAULT_SETTINGS.timeFreezeMinMs;

  const snapDelay = Number(base.timeFreezeSnapshotDelayMs);
  base.timeFreezeSnapshotDelayMs = Number.isFinite(snapDelay)
    ? Math.min(15000, Math.max(200, snapDelay))
    : DEFAULT_SETTINGS.timeFreezeSnapshotDelayMs;

  base.newsHosts = parseHostList(base.newsHosts);
  base.softwallHosts = parseHostList(base.softwallHosts);
  base.denyHosts = parseHostList(base.denyHosts);
  base.allowHosts = parseHostList(base.allowHosts);

  base.hideRules = Array.isArray(base.hideRules)
    ? base.hideRules.filter((r) => typeof r === 'string' && r.trim())
    : [];
  base.siteCss = base.siteCss && typeof base.siteCss === 'object' ? base.siteCss : {};
  base.features = {
    ...DEFAULT_SETTINGS.features,
    ...(base.features && typeof base.features === 'object' ? base.features : {}),
  };
  base.version = Math.max(2, Number(base.version) || 2);

  return base;
}

export function effectiveNewsHosts(settings) {
  const s = normalizeSettings(settings);
  const extra = s.newsHosts || [];
  if (s.useDefaultNewsHosts) {
    return [...new Set([...DEFAULT_NEWS_HOSTS, ...extra].map(normalizeHost))];
  }
  return [...new Set(extra.map(normalizeHost))];
}

export function effectiveSoftwallHosts(settings) {
  const s = normalizeSettings(settings);
  const extra = s.softwallHosts || [];
  if (s.useDefaultSoftwallHosts) {
    return [...new Set([...DEFAULT_SOFTWALL_HOSTS, ...extra].map(normalizeHost))];
  }
  return [...new Set(extra.map(normalizeHost))];
}

export function effectiveHideRules(settings) {
  const s = normalizeSettings(settings);
  if (!s.elementHiding) return [];
  const user = s.hideRules || [];
  if (s.useDefaultHideRules) {
    return [...DEFAULT_HIDE_RULES, ...user];
  }
  return [...user];
}

/**
 * Resolve whether GAF should run on a given page URL.
 * Exclusions (allow-style) come from settings.allowHosts AND external exclusion list.
 */
export function resolveSitePolicy(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  if (!s.enabled) {
    return { active: false, host: '', reason: 'disabled' };
  }

  let host = '';
  try {
    host = normalizeHost(new URL(pageUrl).hostname);
  } catch {
    return { active: false, host: '', reason: 'invalid-url' };
  }

  if (!host) {
    return { active: false, host: '', reason: 'no-host' };
  }

  if (hostMatchesList(host, s.denyHosts)) {
    return { active: true, host, reason: 'deny-list' };
  }

  const excluded =
    hostMatchesList(host, s.allowHosts) || hostMatchesList(host, exclusionHosts);
  if (excluded) {
    return { active: false, host, reason: 'excluded' };
  }

  return { active: true, host, reason: 'default' };
}

export function isNewsHost(host, settings) {
  const h = normalizeHost(host);
  return effectiveNewsHosts(settings).some((n) => h === n || h.endsWith(`.${n}`));
}

export function isSoftwallHost(host, settings) {
  const h = normalizeHost(host);
  return effectiveSoftwallHosts(settings).some((n) => h === n || h.endsWith(`.${n}`));
}

const PLAYER_PATH_RE =
  /\/(watch|video|videos|player|embed|clip|clips|live|tv|episode|play|media)\b/i;

/**
 * Game / puzzle / interactive app paths.
 * These use multi-second setTimeout for UX (toasts, win modals, turn delays) —
 * the same timer stretch that soft-paywalls abuse. Host-level softwall lists
 * (e.g. nytimes.com) must not freeze Wordle for minutes after "Magnificent".
 *
 * Keep in sync with early.js GAME_PUZZLE_PATH_RE / looksLikeGameOrPuzzlePath.
 */
export const GAME_PUZZLE_PATH_RE =
  /\/(games?|puzzles?|crosswords?(?:-puzzles?)?|wordle|connections|strands|spelling-bee|sudoku|letter-boxed|tiles|queens|interactive|quizzes?|trivia)(\/|$|[-_])/i;

export function looksLikeGameOrPuzzlePage(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  const host = normalizeHost(url.hostname);
  // Dedicated games hosts (games.nytimes.com, games.washingtonpost.com, …)
  if (/^games?\./.test(host) || host.startsWith('puzzles.')) return true;
  // Tirsdagsquizen iframe origin — submit overlay uses long-ish UX, not meters
  if (isQuizWidgetHost(host)) return true;
  const path = url.pathname || '/';
  return GAME_PUZZLE_PATH_RE.test(path);
}

/** Dedicated streaming / player hosts — never freeze video, pause motion, or unstick overlays. */
export const MEDIA_PLAYER_HOST_RE =
  /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|music\.youtube\.com|vimeo\.com|player\.vimeo\.com|twitch\.tv|player\.twitch\.tv|netflix\.com|disneyplus\.com|hulu\.com|primevideo\.com|tv\.apple\.com|max\.com|spotify\.com|soundcloud\.com|dailymotion\.com|tiktok\.com|rumble\.com|kick\.com)$/i;

export function isMediaPlayerHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return false;
  return MEDIA_PLAYER_HOST_RE.test(h);
}

export function looksLikePlayerPage(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (isMediaPlayerHost(url.hostname)) return true;
  const path = url.pathname || '/';
  if (PLAYER_PATH_RE.test(path)) return true;
  if (url.searchParams.has('v') && /youtube|youtu\.be|vimeo/i.test(url.hostname)) return true;
  return false;
}

export function isFrontOrSectionRoot(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  const path = (url.pathname || '/').replace(/\/+$/, '') || '/';
  if (path === '/') return true;
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 1 && !/\d{4,}/.test(segments[0])) return true;
  return false;
}

/** Article-like path (not pure home/section root, not games/puzzles). */
export function looksLikeArticlePage(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  if (isFrontOrSectionRoot(pageUrl)) return false;
  if (looksLikePlayerPage(pageUrl)) return false;
  if (looksLikeGameOrPuzzlePage(pageUrl)) return false;
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  const path = url.pathname || '';
  if (path.length < 8) return false;
  // Common article patterns
  if (/\/\d{4}\/\d{2}\//.test(path)) return true;
  if (/\/(news|article|story|politics|sport|business|world|culture)\//i.test(path)) return true;
  if (path.split('/').filter(Boolean).length >= 2) return true;
  return false;
}

export function shouldFreezeVideoOnPage(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  const policy = resolveSitePolicy(pageUrl, s, exclusionHosts);
  if (!policy.active) return false;
  if (s.videoPolicy === 'off') return false;
  if (looksLikePlayerPage(pageUrl)) return false;

  if (s.videoPolicy === 'heuristic') {
    return true;
  }

  if (!isNewsHost(policy.host, s)) return false;
  return isFrontOrSectionRoot(pageUrl);
}

export function shouldFreezeImagesOnPage(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  if (!s.freezeImages) return false;
  return resolveSitePolicy(pageUrl, s, exclusionHosts).active;
}

/**
 * Complex filter/tool/app SPAs — timers + modals must not be disturbed.
 * Keep in sync with early.js and unstick-early.js TOOL_SPA_HOST_RE.
 *
 * x.ai / Grok: Account → Usage settings panel was force-unstuck (disappeared)
 * when body lock + dialog chrome looked like a consent wall.
 *
 * x.com / twitter.com: reply/compose sheet uses a full-viewport mask + body
 * overflow lock. Interaction-guard treated the mask as an orphan cookie grey
 * (clicks passed through to the timeline; compose chrome clipped / Reply dead).
 * GIF / video freeze still runs — only unstick, CSS motion, and scripted
 * motion pause are skipped for tool SPAs.
 */
export const TOOL_SPA_HOST_RE =
  /(^|\.)(filterblade\.xyz|pathofexile\.com|maxroll\.gg|poe\.ninja|poewiki\.net|overgear\.com|x\.ai|grok\.com|x\.com|twitter\.com)$/i;

export function isToolSpaHost(hostname) {
  const h = normalizeHost(hostname);
  return Boolean(h && TOOL_SPA_HOST_RE.test(h));
}

export function looksLikeToolSpaPage(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  try {
    return isToolSpaHost(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * First-party payment-auth windows (BankID / Morrow 3DS).
 *
 * GAF does not intercept window.open. The false block is interaction-guard
 * treating the BankID/Morrow overlay (or the popup document itself) as an
 * orphan cookie dimmer — a full-viewport scrim whose cross-origin iframe
 * has no readable text, so it looks empty. Helium 2026-09-08: Starlink
 * checkout, Morrow Bank card, Norwegian national ID + BankID step never
 * appeared until GAF was turned off.
 *
 * Narrow host allow only. Ads and unrelated popups stay filtered.
 * Keep in sync with early.js, unstick-early.js, and interaction-guard.mjs.
 */
export const PAYMENT_AUTH_HOST_RE =
  /(^|\.)(bankid\.no|morrowbank\.no|morrowbank\.com)$/i;

export function isPaymentAuthHost(hostname) {
  const h = normalizeHost(hostname);
  return Boolean(h && PAYMENT_AUTH_HOST_RE.test(h));
}

export function looksLikePaymentAuthPage(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  try {
    return isPaymentAuthHost(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Third-party newspaper quiz widgets (Tirsdagsquizen / Polaris local papers).
 *
 * The quiz lives in a cross-origin iframe (`quiz-43ns.onrender.com/widget.html`).
 * Interaction-guard treated its submit UI (`#confirmOverlay`, full-viewport
 * rgba scrim + "Send inn") as Ditur's empty shop dimmer, so Submit appeared
 * to do nothing. Narrow host allow only — the newspaper article stays filtered.
 * Keep in sync with early.js and unstick-early.js.
 */
export const QUIZ_WIDGET_HOST_RE = /(^|\.)quiz-43ns\.onrender\.com$/i;

export function isQuizWidgetHost(hostname) {
  const h = normalizeHost(hostname);
  return Boolean(h && QUIZ_WIDGET_HOST_RE.test(h));
}

export function looksLikeQuizWidgetPage(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  try {
    return isQuizWidgetHost(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

export function shouldPauseScriptedMotionOnPage(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  if (!s.pauseScriptedMotion) return false;
  // YouTube / streaming players use WAAPI for controls; pausing freezes fullscreen UI
  if (looksLikePlayerPage(pageUrl)) return false;
  // FilterBlade etc. use animations/timers for UI state — pausing snaps controls back
  if (looksLikeToolSpaPage(pageUrl)) return false;
  // BankID / Morrow 3DS client: animation + timers are the auth UI, not decoration
  if (looksLikePaymentAuthPage(pageUrl)) return false;
  // Tirsdagsquizen iframe: submit overlay + slide transitions are the product
  if (looksLikeQuizWidgetPage(pageUrl)) return false;
  return resolveSitePolicy(pageUrl, s, exclusionHosts).active;
}

export function shouldApplyMotionOnPage(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  if (s.motionLevel === 'off') return false;
  // Fullscreen video UIs rely on CSS transitions; moderate/strict motion can black-screen them
  if (looksLikePlayerPage(pageUrl)) return false;
  // Keep FilterBlade CSS transitions for modal open/close
  if (looksLikeToolSpaPage(pageUrl)) return false;
  if (looksLikePaymentAuthPage(pageUrl)) return false;
  if (looksLikeQuizWidgetPage(pageUrl)) return false;
  return resolveSitePolicy(pageUrl, s, exclusionHosts).active;
}

export function shouldTimeFreezeOnPage(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  if (s.timeFreezeMode === 'off') return false;
  if (s.features?.timeFreeze === false) return false;
  const policy = resolveSitePolicy(pageUrl, s, exclusionHosts);
  if (!policy.active) return false;
  // Skip pure app-like player pages
  if (looksLikePlayerPage(pageUrl)) return false;
  // Skip games/puzzles: their long timers are UX beats, not soft-paywall meters
  // (Wordle "Magnificent" → stats modal uses ~2–3s timeouts; ×80 ≈ multi-minute freeze)
  if (looksLikeGameOrPuzzlePage(pageUrl)) return false;
  // FilterBlade-like tools: long timers drive UI; stretching reverts selections
  if (looksLikeToolSpaPage(pageUrl)) return false;
  // BankID / Morrow: stretching auth-step timers stalls the challenge window
  if (looksLikePaymentAuthPage(pageUrl)) return false;
  // Tirsdagsquizen iframe: also covered by looksLikeGameOrPuzzlePage via host

  // Default: only soft-paywall hosts — avoids breaking lazy-load on local papers (e.g. av-avis.no)
  if (s.timeFreezeScope === 'softwall') {
    return isSoftwallHost(policy.host, s);
  }
  return true;
}

export function shouldElementHideOnPage(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  if (!s.elementHiding) return false;
  return resolveSitePolicy(pageUrl, s, exclusionHosts).active;
}

export function shouldCustomCssOnPage(pageUrl, settings, exclusionHosts = []) {
  const s = normalizeSettings(settings);
  if (!s.customCss) return false;
  return resolveSitePolicy(pageUrl, s, exclusionHosts).active;
}

/**
 * Export pack for backup / share (settings only; archive separate).
 */
export function buildExportPack(settings, exclusions = []) {
  return {
    format: 'gaf-filter-pack',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    settings: normalizeSettings(settings),
    exclusions,
  };
}

export function parseImportPack(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    data = JSON.parse(raw);
  }
  if (!data || data.format !== 'gaf-filter-pack') {
    throw new Error('Not a GAF filter pack');
  }
  return {
    settings: normalizeSettings(data.settings),
    exclusions: Array.isArray(data.exclusions) ? data.exclusions : [],
  };
}
