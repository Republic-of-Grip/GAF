/**
 * GAF main content script (document_idle, isolated world, all frames).
 */

let settings = null;
let exclusionHosts = [];
let observer = null;
let debounceTimer = null;
let scriptedTimer = null;
let snapshotTimer = null;
let unstickTimer = null;
let unstickWatch = null;
let corePromise = null;
let lastUrl = '';
let lastContextElement = null;
let unstickPasses = 0;
let unstickWatchUrl = '';

const MEDIA_EVENTS = ['play', 'playing', 'timeupdate', 'loadeddata', 'canplay', 'load'];
const DEBOUNCE_MS = 80;
const SCRIPTED_INTERVAL_MS = 2000;
/** Delay first scripted-motion pass so Alpine/Hyvä modals can finish open transitions. */
const SCRIPTED_WARMUP_MS = 2500;
/** Burst delays after load (ms). Continuous watch also runs while page stays locked. */
const UNSTICK_DELAYS_MS = [400, 900, 1500, 2500, 4000, 7000, 12000];
const UNSTICK_WATCH_MS = 500;
const UNSTICK_WATCH_MAX_TICKS = 40; // ~20s

function loadCore() {
  if (!corePromise) {
    corePromise = Promise.all([
      import(chrome.runtime.getURL('src/core/settings.mjs')),
      import(chrome.runtime.getURL('src/core/storage.mjs')),
      import(chrome.runtime.getURL('src/core/freeze-media.mjs')),
      import(chrome.runtime.getURL('src/core/scripted-motion.mjs')),
      import(chrome.runtime.getURL('src/core/css-motion.mjs')),
      import(chrome.runtime.getURL('src/core/element-hide.mjs')),
      import(chrome.runtime.getURL('src/core/site-css.mjs')),
      import(chrome.runtime.getURL('src/core/time-freeze.mjs')),
      import(chrome.runtime.getURL('src/core/archive.mjs')),
      import(chrome.runtime.getURL('src/core/exclusions.mjs')),
      import(chrome.runtime.getURL('src/core/interaction-guard.mjs')),
      import(chrome.runtime.getURL('src/core/meter-reset.mjs')),
    ]).then((mods) => Object.assign({}, ...mods));
  }
  return corePromise;
}

function pageUrl() {
  return globalThis.location?.href || document.location?.href || '';
}

async function refreshState() {
  const core = await loadCore();
  // Local-first — same authoritative path as popup / options / service worker
  // (Helium sync cannot always be trusted; see storage.mjs).
  try {
    settings = await core.loadSettings();
  } catch {
    settings = core.normalizeSettings(core.DEFAULT_SETTINGS);
  }
  try {
    exclusionHosts = await core.getActiveExclusionHosts();
  } catch {
    try {
      const local = await chrome.storage.local.get({ gafExclusions: [] });
      exclusionHosts = core.activeExclusionHosts(local.gafExclusions || []);
    } catch {
      exclusionHosts = [];
    }
  }
  return settings;
}

function pushTimeFreezeConfig(core, s, pageHref) {
  const url = pageHref || pageUrl();
  const enabled = core.shouldTimeFreezeOnPage(url, s, exclusionHosts);
  const cfg = core.timeFreezeMainConfig(s, { enabled });
  try {
    window.postMessage({ source: 'gaf-extension', ...cfg }, '*');
    window.dispatchEvent(new CustomEvent('gaf-time-freeze-config', { detail: cfg }));
  } catch {
    /* ignore */
  }
}

async function applyAll() {
  const core = await loadCore();
  const s = settings || (await refreshState());
  const url = pageUrl();
  if (url !== lastUrl) {
    unstickPasses = 0;
    cancelMeterHandling();
  }
  lastUrl = url;

  const site = core.resolveSitePolicy(url, s, exclusionHosts);

  if (!site.active) {
    stopUnstickWatch();
    cancelMeterHandling();
    core.restoreMeterWall(document);
    core.restoreScriptedMotion(document);
    core.removeMotionStyle(document);
    core.removeHideStyle(document);
    core.removeSiteCss(document);
    core.removeReadingSnapshot(document);
    core.restoreFrozenMedia(document);
    core.restoreInteractionUnlock?.(document);
    try {
      globalThis.__gafRestoreUnstick?.();
    } catch {
      /* ignore */
    }
    pushTimeFreezeConfig(core, { timeFreezeMode: 'off', timeFreezeMinMs: 2000 }, url);
    stopScriptedLoop();
    clearTimeout(snapshotTimer);
    return { active: false };
  }

  pushTimeFreezeConfig(core, s, url);

  if (core.shouldApplyMotionOnPage(url, s, exclusionHosts)) {
    core.applyMotionStyle(document, s.motionLevel);
  } else {
    core.removeMotionStyle(document);
  }

  if (core.shouldElementHideOnPage(url, s, exclusionHosts)) {
    core.applyHideStyle(document, core.effectiveHideRules(s));
  } else {
    core.removeHideStyle(document);
  }

  if (core.shouldCustomCssOnPage(url, s, exclusionHosts)) {
    core.applySiteCss(document, core.cssForHost(s.siteCss, site.host));
  } else {
    core.removeSiteCss(document);
  }

  const freezeImages = core.shouldFreezeImagesOnPage(url, s, exclusionHosts);
  const freezeVideos = core.shouldFreezeVideoOnPage(url, s, exclusionHosts);

  const result = core.freezeMediaIn(document, {
    freezeImages,
    freezeVideos,
    includeModern: false,
    strictHeuristic: s.videoPolicy === 'heuristic',
    document,
  });

  if (!freezeVideos) {
    core.restoreFrozenMedia(document, { types: ['video', 'preview-video'] });
    core.removePreviewVideoFreezeStyle?.(document);
  }
  if (!freezeImages) {
    core.restoreFrozenMedia(document, { types: ['image'] });
  }

  if (core.shouldPauseScriptedMotionOnPage(url, s, exclusionHosts)) {
    // Warmup: let Alpine/Hyvä modal enter transitions finish before pausing SMIL/WAAPI
    if (performance.now() > SCRIPTED_WARMUP_MS) {
      core.pauseAllScriptedMotion(document);
    }
    startScriptedLoop();
  } else {
    stopScriptedLoop();
    core.restoreScriptedMotion(document);
  }

  // Snapshot only when time freeze is actually active on this page
  if (core.shouldTimeFreezeOnPage(url, s, exclusionHosts)) {
    scheduleSnapshotIfNeeded(core, s, url);
  } else {
    clearTimeout(snapshotTimer);
    if (s.timeFreezeMode !== 'stop') {
      core.removeReadingSnapshot(document);
    }
  }

  scheduleUnstickPasses();
  // Meter handling: always disarm when enabled; cookie wipe auto when mode=auto
  scheduleMeterHandling(core, s, url);

  // Keep toolbar badge honest while filtering (clears stuck per-tab OFF)
  try {
    chrome.runtime.sendMessage({ type: 'GAF_SYNC_BADGE' }).catch(() => {});
  } catch {
    /* ignore */
  }

  return { active: true, host: site.host, ...result };
}

const METER_DISARM_DELAYS_MS = [0, 400, 1200, 3000, 6000];
let meterDisarmScheduledFor = '';
const meterAutoScheduled = new Set();
const meterTimers = new Set();
let meterGeneration = 0;

function cancelMeterHandling() {
  meterGeneration += 1;
  for (const timer of meterTimers) clearTimeout(timer);
  meterTimers.clear();
  meterAutoScheduled.clear();
  meterDisarmScheduledFor = '';
}

function scheduleMeterTask(callback, delay) {
  const generation = meterGeneration;
  const timer = setTimeout(() => {
    meterTimers.delete(timer);
    if (generation === meterGeneration) callback();
  }, delay);
  meterTimers.add(timer);
}

/**
 * Hide free-article gate chrome when body is already in the DOM (Spiked pattern).
 * Always attempts when policy allows — do not require detectMeterWall first
 * (inactive gates are display:none but still worth nuking if .active flips later).
 */
function maybeDisarmMeter(core, s, url) {
  try {
    if (!core.shouldDisarmMeterOnPage(url, s, exclusionHosts)) return null;
    // Softwall hosts: always disarm known gate chrome
    // Other hosts: only if gate markers present
    const soft = core.isSoftwallHost(core.normalizeHost(location.hostname), s);
    if (!soft) {
      const hasGate = document.querySelector?.(
        '.gated-content-wrap.paywall, .gated-content-notice, [data-testid*="regwall" i]'
      );
      if (!hasGate) return null;
    }
    return core.disarmMeterWall(document);
  } catch {
    return null;
  }
}

/** Scheduled actions always consult current settings; the worker owns wipe retries. */
function scheduleMeterHandling(core, s, url) {
  if (window !== window.top) return;
  if (!core.shouldDisarmMeterOnPage(url, s, exclusionHosts) &&
      !core.shouldAutoMeterReset(url, s, exclusionHosts)) {
    cancelMeterHandling();
    core.restoreMeterWall(document);
    return;
  }
  if (meterDisarmScheduledFor !== url && s.meterDisarm !== false) {
    meterDisarmScheduledFor = url;
    for (const delay of METER_DISARM_DELAYS_MS) {
      scheduleMeterTask(() => {
        if (pageUrl() !== url || !settings) return;
        maybeDisarmMeter(core, settings, url);
      }, delay);
    }
  }
  if (!core.shouldAutoMeterReset(url, s, exclusionHosts)) return;
  const autoKey = core.meterAutoStorageKey(url);
  if (meterAutoScheduled.has(autoKey)) return;
  meterAutoScheduled.add(autoKey);
  scheduleMeterTask(() => {
    if (pageUrl() !== url || !core.shouldAutoMeterReset(url, settings, exclusionHosts)) return;
    const disarm = maybeDisarmMeter(core, settings, url);
    if (disarm?.useful) return;
    const hit = core.detectMeterWall(document);
    if (!core.shouldEscalateMeterWipe(hit)) return;
    chrome.runtime.sendMessage({
      type: 'GAF_RESET_METER', url, reload: true, forceReload: true, auto: true,
    }).catch(() => {});
  }, 1500);
}

/**
 * Clear interaction blockers after load and while the page stays locked:
 * - explicit reject-all / necessary-only consent choices
 * - leave ambiguous consent choices visible for the user
 * - orphan full-viewport dimmers with no usable dialog
 * Leaves login / cart / filter panels alone when not a consent lock.
 */
function scheduleUnstickPasses() {
  const url = pageUrl();
  if (url !== lastUrl && url !== unstickWatchUrl) {
    unstickPasses = 0;
  }
  // Burst of timed passes (once per URL)
  if (!(unstickPasses > 0 && url === lastUrl)) {
    unstickPasses = 1;
    unstickWatchUrl = url;
    clearTimeout(unstickTimer);
    for (const delay of UNSTICK_DELAYS_MS) {
      setTimeout(() => {
        runUnstick().catch(() => {});
      }, delay);
    }
  }
  startUnstickWatch();
}

function stopUnstickWatch() {
  if (unstickWatch != null) {
    clearInterval(unstickWatch);
    unstickWatch = null;
  }
}

function startUnstickWatch() {
  if (unstickWatch != null) return;
  let ticks = 0;
  unstickWatch = setInterval(() => {
    ticks += 1;
    runUnstick({ force: ticks >= 6 })
      .then((r) => {
        const still =
          document.body?.classList?.contains?.('noscroll') ||
          document.body?.classList?.contains?.('phantom-scroll-bar');
        if (!still && r && r.reason !== 'noop' && r.reason !== 'none-found') {
          // Unlocked — keep watching a few more ticks in case Alpine re-locks
          if (ticks > 8) stopUnstickWatch();
        }
        if (ticks >= UNSTICK_WATCH_MAX_TICKS) stopUnstickWatch();
      })
      .catch(() => {
        if (ticks >= UNSTICK_WATCH_MAX_TICKS) stopUnstickWatch();
      });
  }, UNSTICK_WATCH_MS);
}

async function runUnstick(opts = {}) {
  const core = await loadCore();
  const s = settings || (await refreshState());
  const url = pageUrl();
  const site = core.resolveSitePolicy(url, s, exclusionHosts);
  if (!site.active) return { cleared: 0, unlocked: false, reason: 'inactive' };
  // Tool SPAs / players: unstick hides legitimate modals (Grok settings, FilterBlade, YT).
  // BankID / Morrow: 3DS overlay looks like an empty cookie grey (cross-origin iframe).
  if (core.looksLikePaymentAuthPage(url)) {
    return { cleared: 0, unlocked: false, reason: 'skipped-payment-auth' };
  }
  // Tirsdagsquizen iframe: #confirmOverlay is the submit dialog, not a Ditur grey
  if (core.looksLikeQuizWidgetPage(url)) {
    return { cleared: 0, unlocked: false, reason: 'skipped-quiz-widget' };
  }
  if (core.looksLikeToolSpaPage(url) || core.looksLikePlayerPage(url)) {
    return { cleared: 0, unlocked: false, reason: 'skipped-tool-spa' };
  }
  return core.unstickOrphanedOverlays(document, globalThis, opts);
}

function scheduleSnapshotIfNeeded(core, s, url) {
  clearTimeout(snapshotTimer);
  if (s.timeFreezeMode !== 'stop' || !s.timeFreezeSnapshot) {
    // Keep existing snapshot if any only in stop mode
    if (s.timeFreezeMode !== 'stop') {
      core.removeReadingSnapshot(document);
    }
    return;
  }
  // Prefer article-like pages; still allow on softwall hosts' article paths
  const article = core.looksLikeArticlePage(url);
  const soft = core.isSoftwallHost(core.normalizeHost(location.hostname), s);
  if (!article && !soft) return;
  // Top frame only
  if (window !== window.top) return;

  const delay = s.timeFreezeSnapshotDelayMs || 1200;
  snapshotTimer = setTimeout(() => {
    if (core.isFreezeActive(document)) return;
    // Only snapshot if there is substantial text (article loaded)
    const textLen = (document.body?.innerText || '').trim().length;
    if (textLen < 400) return;
    core.applyReadingSnapshot(document, {
      onThaw: () => {
        // User chose live page — leave timers as configured
      },
    });
  }, delay);
}

function scheduleApply(delay = DEBOUNCE_MS) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    applyAll().catch(() => {});
  }, delay);
}

async function onVideoEvent(video) {
  const core = await loadCore();
  const s = settings || (await refreshState());
  const url = pageUrl();
  if (!core.shouldFreezeVideoOnPage(url, s, exclusionHosts)) {
    core.restoreFrozenMedia([video], { types: ['video'] });
    return;
  }
  core.freezeVideoElement(video, { strictHeuristic: s.videoPolicy === 'heuristic' });
}

function mediaEventHandler(event) {
  const target = event.target;
  if (!target) return;
  if (target.tagName === 'VIDEO') {
    if (event.type === 'play' && event.isTrusted && target.dataset?.gafUserPlay === '1') {
      return;
    }
    onVideoEvent(target).catch(() => {});
    // Nested video inside <preview-video> shadow / light DOM
    const host = target.closest?.('preview-video, [class*="preview-video"]');
    if (host) scheduleApply(0);
  } else if (target.tagName === 'PREVIEW-VIDEO' || /preview-video/i.test(target.className || '')) {
    scheduleApply(0);
  } else if (target.tagName === 'IMG' && (event.type === 'load' || event.type === 'loadeddata')) {
    scheduleApply(0);
  }
}

/** Stable refs so enable/disable cycles do not accumulate handlers. */
async function frozenVideoClickHandler(event) {
  const video = event.target?.closest?.('video');
  if (!video || video.dataset?.gafFrozen !== 'video') return;
  const core = await loadCore();
  core.allowVideoPlay(video);
}

function contextMenuTrackHandler(event) {
  lastContextElement = event.target;
}

function addMediaEventListeners() {
  for (const name of MEDIA_EVENTS) {
    document.addEventListener(name, mediaEventHandler, true);
  }
  document.addEventListener('click', frozenVideoClickHandler, true);
  // Track right-click target for context menu archive
  document.addEventListener('contextmenu', contextMenuTrackHandler, true);
}

function removeMediaEventListeners() {
  for (const name of MEDIA_EVENTS) {
    document.removeEventListener(name, mediaEventHandler, true);
  }
  document.removeEventListener('click', frozenVideoClickHandler, true);
  document.removeEventListener('contextmenu', contextMenuTrackHandler, true);
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    let need = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        need = true;
        break;
      }
      if (mutation.type === 'attributes') {
        const tag = mutation.target?.tagName;
        if (tag === 'VIDEO' || tag === 'IMG' || tag === 'SOURCE' || tag?.includes?.('-')) {
          need = true;
          break;
        }
      }
    }
    if (need) scheduleApply(DEBOUNCE_MS);
  });

  const root = document.documentElement || document;
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    // class: VG adds preview-video-in-screen / preview-video-loaded to start loops
    attributeFilter: [
      'src',
      'srcset',
      'data-src',
      'data-srcset',
      'autoplay',
      'loop',
      'poster',
      'preload',
      'class',
    ],
  });
  addMediaEventListeners();
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
  removeMediaEventListeners();
  clearTimeout(debounceTimer);
  clearTimeout(snapshotTimer);
  stopScriptedLoop();
}

function startScriptedLoop() {
  if (scriptedTimer) return;
  scriptedTimer = setInterval(() => {
    if (performance.now() < SCRIPTED_WARMUP_MS) return;
    loadCore().then((core) => {
      if (settings && core.shouldPauseScriptedMotionOnPage(pageUrl(), settings, exclusionHosts)) {
        core.pauseAllScriptedMotion(document);
      }
    });
  }, SCRIPTED_INTERVAL_MS);
}

function stopScriptedLoop() {
  if (scriptedTimer) {
    clearInterval(scriptedTimer);
    scriptedTimer = null;
  }
}

function hookHistory() {
  const notify = () => {
    if (pageUrl() !== lastUrl) scheduleApply(0);
  };
  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
  const wrap = (type) => {
    const orig = history[type];
    if (typeof orig !== 'function') return;
    history[type] = function gafHistoryWrapped(...args) {
      const ret = orig.apply(this, args);
      notify();
      return ret;
    };
  };
  try {
    wrap('pushState');
    wrap('replaceState');
  } catch {
    /* ignore */
  }
}

function tearDownFiltering(core) {
  cancelMeterHandling();
  core.restoreMeterWall(document);
  core.restoreScriptedMotion(document);
  stopObserver();
  stopUnstickWatch();
  core.removeMotionStyle(document);
  core.removeHideStyle(document);
  core.removeSiteCss(document);
  core.removeReadingSnapshot(document);
  core.restoreFrozenMedia(document);
  core.restoreInteractionUnlock?.(document);
  try {
    globalThis.__gafRestoreUnstick?.();
  } catch {
    /* ignore */
  }
  // Tell early unstick to stop (master off / excluded)
  try {
    globalThis.__gafUnstickSetActive?.(false);
  } catch {
    /* ignore */
  }
  pushTimeFreezeConfig(core, { timeFreezeMode: 'off', timeFreezeMinMs: 2000 });
}

async function setEnabledFromSettings() {
  const core = await loadCore();
  await refreshState();
  if (!settings.enabled) {
    tearDownFiltering(core);
    return;
  }
  const site = core.resolveSitePolicy(pageUrl(), settings, exclusionHosts);
  if (!site.active) {
    tearDownFiltering(core);
    return;
  }
  try {
    globalThis.__gafUnstickSetActive?.(true);
  } catch {
    /* ignore */
  }
  startObserver();
  await applyAll();
  setTimeout(() => applyAll().catch(() => {}), 750);
  setTimeout(() => applyAll().catch(() => {}), 2000);
}

async function archiveLastContextElement() {
  const core = await loadCore();
  const el = lastContextElement;
  if (!el) {
    return { ok: false, error: 'No element under cursor. Right-click the object again.' };
  }
  const entry = core.serializeElement(el, pageUrl(), document.title || '');
  if (!entry) return { ok: false, error: 'Could not serialize element' };
  return { ok: true, entry };
}

// Boot
(async () => {
  try {
    hookHistory();
    await setEnabledFromSettings();
  } catch (err) {
    console.warn('[GAF] init failed', err);
  }
})();

chrome.storage.onChanged.addListener(() => {
  setEnabledFromSettings().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GAF_SETTINGS' || message?.type === 'GAF_EXCLUSIONS_CHANGED') {
    setEnabledFromSettings()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'GAF_PING') {
    sendResponse({ ok: true, url: pageUrl() });
    return false;
  }
  if (message?.type === 'GAF_RUN_NOW') {
    applyAll()
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'GAF_ARCHIVE_ELEMENT') {
    archiveLastContextElement()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'GAF_THAW') {
    loadCore().then((core) => {
      core.removeReadingSnapshot(document);
      // Uncover: dismiss locking cookie walls, hard-uncover if needed
      const unstick = core.unstickOrphanedOverlays(document, globalThis, { force: true });
      sendResponse({ ok: true, unstick });
    });
    return true;
  }
  if (message?.type === 'GAF_UNSTICK') {
    runUnstick({ force: true })
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'GAF_SNAPSHOT_NOW') {
    loadCore().then((core) => {
      const ok = core.applyReadingSnapshot(document);
      sendResponse({ ok });
    });
    return true;
  }
  if (['GAF_CLEAR_PAGE_STORAGE', 'GAF_DETECT_METER_WALL', 'GAF_DISARM_METER'].includes(message?.type)) {
    (async () => {
      const core = await loadCore();
      await refreshState();
      const url = pageUrl();
      if (window !== window.top || (message.expectedUrl && message.expectedUrl !== url) ||
          !core.resolveSitePolicy(url, settings, exclusionHosts).active ||
          !settings.meterResetEnabled || settings.features?.meterReset === false ||
          (message.auto && !core.shouldAutoMeterReset(url, settings, exclusionHosts))) {
        return { ok: false, error: 'inactive-or-page-changed' };
      }
      if (message.type === 'GAF_DETECT_METER_WALL') {
        return { ok: true, ...core.detectMeterWall(document), articleChars: core.measureArticleText(document) };
      }
      if (message.type === 'GAF_DISARM_METER') {
        if (!settings.meterDisarm) return { ok: true, useful: false, articleChars: core.measureArticleText(document) };
        return { ok: true, ...core.disarmMeterWall(document) };
      }
      // Only an explicit worker request bound to this page may clear storage.
      if (message.auto || !message.expectedUrl) return { ok: false, error: 'manual-only' };
      if (message.webStorage === true) {
        localStorage.clear();
        sessionStorage.clear();
      }
      if (message.durable === true) {
        if (globalThis.indexedDB?.databases) {
          const dbs = await indexedDB.databases();
          await Promise.all((dbs || []).filter((db) => db.name).map((db) => new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('Close other tabs for this site before deleting its databases.'));
          })));
        }
        if (globalThis.caches?.keys) {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        }
      }
      return { ok: true };
    })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  return false;
});
