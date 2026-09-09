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
    meterDisarmScheduledFor = '';
  }
  lastUrl = url;

  const site = core.resolveSitePolicy(url, s, exclusionHosts);

  if (!site.active) {
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

/**
 * Auto meter pipeline:
 * 1) Multi-pass DOM disarm (works even when mode is manual — user wanted automatic)
 * 2) If mode=auto and body still empty after disarm, cookie/storage wipe + reload once
 */
function scheduleMeterHandling(core, s, url) {
  if (!s?.meterResetEnabled || s.features?.meterReset === false) return;
  if (!core.shouldDisarmMeterOnPage(url, s, exclusionHosts) && s.meterResetMode === 'off') {
    return;
  }

  // Multi-pass disarm on every navigation (not gated on meterResetMode)
  if (meterDisarmScheduledFor !== url && s.meterDisarm !== false) {
    meterDisarmScheduledFor = url;
    for (const delay of METER_DISARM_DELAYS_MS) {
      setTimeout(() => {
        try {
          if (pageUrl() !== url) return;
          maybeDisarmMeter(core, s, url);
        } catch {
          /* ignore */
        }
      }, delay);
    }
  }

  // Cookie wipe only in auto mode, once per top-level URL path
  if (s.meterResetMode !== 'auto') return;
  const autoKey = core.meterAutoStorageKey(url);
  if (meterAutoScheduled.has(autoKey)) return;
  try {
    if (sessionStorage.getItem(autoKey) === '1') return;
  } catch {
    /* private mode */
  }
  if (!core.shouldAutoMeterReset(url, s, exclusionHosts)) return;

  meterAutoScheduled.add(autoKey);
  setTimeout(() => {
    try {
      if (pageUrl() !== url) return;
      try {
        if (sessionStorage.getItem(autoKey) === '1') return;
      } catch {
        /* ignore */
      }
      const markDone = () => {
        try {
          sessionStorage.setItem(autoKey, '1');
        } catch {
          /* ignore */
        }
      };
      const disarm = core.disarmMeterWall(document);
      if (disarm?.useful) {
        markDone();
        return;
      }
      const hit = core.detectMeterWall(document);
      const escalate = core.shouldEscalateMeterWipe({
        strongSelector: hit.strongSelector,
        selectorHit: hit.selectorHit,
        textHit: hit.textHit,
        disarmUseful: false,
        articleChars: disarm?.articleChars || 0,
      });
      if (!escalate) {
        markDone();
        return;
      }
      markDone();
      chrome.runtime
        .sendMessage({
          type: 'GAF_RESET_METER',
          url,
          reload: true,
          forceReload: true,
          auto: true,
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }, 1500);
}

/**
 * Clear interaction blockers after load and while the page stays locked:
 * - page-locking first-party cookie walls (ditur Godta valgte / Godta alle)
 * - hard uncover if Alpine ignores the click (hide grey + seed cookie_consent)
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
  if (message?.type === 'GAF_CLEAR_PAGE_STORAGE') {
    (async () => {
      try {
        localStorage.clear();
      } catch {
        /* ignore */
      }
      try {
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
      // IndexedDB / Cache Storage only when explicitly requested (manual + opted in)
      if (message.durable === true) {
        try {
          if (indexedDB?.databases) {
            const dbs = await indexedDB.databases();
            await Promise.all(
              (dbs || []).map(
                (db) =>
                  new Promise((resolve) => {
                    if (!db?.name) return resolve();
                    const req = indexedDB.deleteDatabase(db.name);
                    req.onsuccess = () => resolve();
                    req.onerror = () => resolve();
                    req.onblocked = () => resolve();
                  })
              )
            );
          }
        } catch {
          /* ignore */
        }
        try {
          if (caches?.keys) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch {
          /* ignore */
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === 'GAF_DETECT_METER_WALL') {
    loadCore()
      .then((core) => {
        const hit = core.detectMeterWall(document);
        const chars = core.measureArticleText(document);
        sendResponse({ ok: true, ...hit, articleChars: chars });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'GAF_DISARM_METER') {
    loadCore()
      .then((core) => {
        const result = core.disarmMeterWall(document);
        sendResponse({ ok: true, ...result });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
