/**
 * GAF video start guard — MAIN world, document_start, all frames.
 *
 * Feeds like X start videos from script: they call video.play() when a post
 * scrolls into view, with no autoplay/loop attributes for GAF's attribute
 * heuristics to see. This guard sits on HTMLVideoElement play() itself.
 *
 * Modes (settings.videoPlayOn, posted by early.js):
 *   click — a video plays only after you click it (or its play button) or
 *           focus it and press Space / Enter / K.
 *   hover — the same, plus resting the pointer on a video (no scrolling) for
 *           a moment plays it; moving off pauses it again.
 *   any   — guard off; the site decides (GAF's older attribute heuristics
 *           still apply).
 *
 * A blocked play() is answered exactly like the browser's own autoplay
 * block: a promise rejected with NotAllowedError. Players already handle
 * that by showing their play button.
 *
 * Never blocked: <audio>, live streams (srcObject — video calls, cameras),
 * elements the user allowed (data-gaf-allow) or already started
 * (data-gaf-user-play), and every video while the guard is disabled
 * (master off, excluded or paused site/tab, player hosts, popups).
 */
(() => {
  if (globalThis.__gafVideoStartMain) return;
  globalThis.__gafVideoStartMain = true;

  const Media = globalThis.HTMLMediaElement;
  const Video = globalThis.HTMLVideoElement;
  if (!Media || !Video) return;

  const nativePlay = Media.prototype.play;
  const nativePause = Media.prototype.pause;

  /** 'click' | 'hover' | 'any'. Decided once early.js sends settings. */
  let mode = 'any';

  /**
   * Before settings arrive (a few ms after document_start) play() calls are
   * held, not started: starting then pausing a moment later is a visible
   * flicker. They are answered when settings arrive — started if allowed,
   * refused if not — so nothing is lost when GAF is off for the page. If no
   * settings ever arrive (extension broken), they start after a short wait.
   */
  let configured = false;
  const held = [];
  /** Videos whose autoplay start GAF held while settings were pending. */
  const heldAutoplay = new Set();
  /** Videos whose autoplay attribute GAF switched off (restored if the guard turns off). */
  const strippedAutoplay = new Set();
  const HOLD_MAX_MS = 2500;
  const holdTimer = setTimeout(() => releaseHeld(true), HOLD_MAX_MS);

  function releaseHeld(failOpen) {
    clearTimeout(holdTimer);
    configured = true;
    for (const v of heldAutoplay) {
      if (failOpen || isAllowed(v)) {
        try {
          if (strippedAutoplay.delete(v)) v.autoplay = true;
          nativePlay.call(v)?.catch?.(() => {});
        } catch {
          /* ignore */
        }
      }
    }
    heldAutoplay.clear();
    const queue = held.splice(0);
    for (const h of queue) {
      if (failOpen || isAllowed(h.video)) {
        try {
          nativePlay.apply(h.video, h.args).then(h.resolve, h.reject);
        } catch (e) {
          h.reject(e);
        }
      } else {
        h.reject(blockedError());
      }
    }
  }

  const HOVER_DWELL_MS = 500;
  const SLACK_PX = 4;
  const PLAY_LABEL_RE = /play|pause|spill|avspill|start|video|afspil|spela/i;

  /** video → 'user' (click / key: stays allowed) | 'hover' (until the pointer leaves). */
  const armed = new WeakMap();
  let hoverVideo = null;

  function now() {
    return Date.now();
  }

  function isLiveStream(video) {
    try {
      return Boolean(video.srcObject);
    } catch {
      return false;
    }
  }

  function isAllowed(video) {
    if (mode === 'any') return true;
    if (!(video instanceof Video)) return true;
    if (isLiveStream(video)) return true;
    if (armed.has(video)) return true;
    try {
      if (video.dataset?.gafUserPlay === '1') return true;
      if (video.closest?.('[data-gaf-allow]')) return true;
    } catch {
      /* detached / odd element */
    }
    return false;
  }

  function blockedError() {
    try {
      return new DOMException('GAF: video starts on click', 'NotAllowedError');
    } catch {
      const e = new Error('GAF: video starts on click');
      e.name = 'NotAllowedError';
      return e;
    }
  }

  Media.prototype.play = function gafPlay(...args) {
    if (!configured && this instanceof Video && !isLiveStream(this)) {
      return new Promise((resolve, reject) => held.push({ video: this, args, resolve, reject }));
    }
    if (isAllowed(this)) return nativePlay.apply(this, args);
    return Promise.reject(blockedError());
  };

  /** Videos whose box contains the point. */
  function videosAt(x, y) {
    const hits = [];
    let list = [];
    try {
      list = document.querySelectorAll('video');
    } catch {
      return hits;
    }
    for (const v of list) {
      let r;
      try {
        r = v.getBoundingClientRect();
      } catch {
        continue;
      }
      if (r.width < 2 || r.height < 2) continue;
      if (x >= r.left - SLACK_PX && x <= r.right + SLACK_PX && y >= r.top - SLACK_PX && y <= r.bottom + SLACK_PX) {
        hits.push(v);
      }
    }
    return hits;
  }

  /** The one video a play/pause control belongs to (closest ancestor holding exactly one). */
  function videoForControl(el) {
    let node = el;
    for (let depth = 0; node && depth < 6; depth += 1) {
      let vids = [];
      try {
        vids = node.querySelectorAll?.('video') || [];
      } catch {
        return null;
      }
      if (vids.length === 1) return vids[0];
      if (vids.length > 1) return null;
      node = node.parentElement;
    }
    return null;
  }

  function looksLikePlayControl(el) {
    const control = el?.closest?.('button, [role="button"]');
    if (!control) return null;
    const label = [
      control.getAttribute('aria-label'),
      control.getAttribute('title'),
      control.getAttribute('data-testid'),
      (control.textContent || '').trim().slice(0, 40),
    ]
      .filter(Boolean)
      .join(' ');
    // Icon-only buttons (no label at all) are usually the big play overlay.
    if (!label || PLAY_LABEL_RE.test(label)) return control;
    return null;
  }

  function armUser(video) {
    if (!video) return;
    armed.set(video, 'user');
    if (hoverVideo === video) hoverVideo = null;
  }

  function onPointerDown(event) {
    if (mode === 'any' || !event.isTrusted || event.button !== 0) return;
    const hits = videosAt(event.clientX, event.clientY);
    if (hits.length) {
      hits.forEach(armUser);
      return;
    }
    const control = looksLikePlayControl(event.target);
    if (control) armUser(videoForControl(control));
  }

  function isTyping(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function onKeyDown(event) {
    if (mode === 'any' || !event.isTrusted) return;
    if (event.key !== ' ' && event.key !== 'Enter' && event.key !== 'k' && event.key !== 'K') return;
    const active = document.activeElement;
    if (!active || isTyping(active)) return;
    if (active instanceof Video) {
      armUser(active);
      return;
    }
    if (active.closest?.('button, [role="button"]') || active.querySelector?.('video')) {
      armUser(videoForControl(active));
    }
  }

  // ---- Hover mode -------------------------------------------------------
  let pointer = null; // { x, y } while the pointer is inside the window
  let lastScroll = 0;
  let dwellTimer = 0;

  function stopHoverVideo() {
    const v = hoverVideo;
    hoverVideo = null;
    if (v && armed.get(v) === 'hover') {
      armed.delete(v);
      try {
        nativePause.call(v);
      } catch {
        /* ignore */
      }
    }
  }

  function checkHover() {
    dwellTimer = 0;
    if (mode !== 'hover' || !pointer) {
      stopHoverVideo();
      return;
    }
    if (now() - lastScroll < HOVER_DWELL_MS) {
      scheduleHover();
      return;
    }
    const under = videosAt(pointer.x, pointer.y)[0] || null;
    if (hoverVideo && hoverVideo !== under) stopHoverVideo();
    if (!under || armed.get(under) === 'user' || isLiveStream(under)) return;
    if (!armed.has(under)) {
      armed.set(under, 'hover');
      hoverVideo = under;
      try {
        nativePlay.call(under)?.catch?.(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleHover() {
    if (mode !== 'hover') return;
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(checkHover, HOVER_DWELL_MS);
  }

  function onPointerMove(event) {
    if (mode !== 'hover' || event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    // Leaving the hovered video pauses it at once; starting needs a dwell.
    if (hoverVideo && !videosAt(pointer.x, pointer.y).includes(hoverVideo)) stopHoverVideo();
    scheduleHover();
  }

  function onScroll() {
    if (mode !== 'hover') return;
    lastScroll = now();
    if (hoverVideo && pointer && !videosAt(pointer.x, pointer.y).includes(hoverVideo)) stopHoverVideo();
    scheduleHover();
  }

  function onPointerLeaveWindow(event) {
    if (event.relatedTarget) return;
    pointer = null;
    stopHoverVideo();
  }

  // ---- Autoplay attribute / already-playing videos -----------------------
  /**
   * loadstart comes before the browser acts on the autoplay attribute, so
   * switching autoplay off here means the video never starts (no flicker).
   */
  function onLoadStart(event) {
    const v = event.target;
    if (!(v instanceof Video) || isLiveStream(v) || !v.autoplay) return;
    if (configured && isAllowed(v)) return;
    try {
      v.autoplay = false;
    } catch {
      return;
    }
    strippedAutoplay.add(v);
    if (!configured) heldAutoplay.add(v);
  }

  function restoreStrippedAutoplay() {
    for (const v of strippedAutoplay) {
      try {
        v.autoplay = true;
        if (v.paused) nativePlay.call(v)?.catch?.(() => {});
      } catch {
        /* ignore */
      }
    }
    strippedAutoplay.clear();
  }

  function onPlayEvent(event) {
    const v = event.target;
    if (!configured && v instanceof Video && !isLiveStream(v)) {
      heldAutoplay.add(v);
      try {
        nativePause.call(v);
      } catch {
        /* ignore */
      }
      return;
    }
    if (v instanceof Video && !isAllowed(v)) {
      try {
        nativePause.call(v);
      } catch {
        /* ignore */
      }
    }
  }

  function pauseUnallowedPlaying() {
    let list = [];
    try {
      list = document.querySelectorAll('video');
    } catch {
      return;
    }
    for (const v of list) {
      if (!v.paused && !isAllowed(v)) {
        try {
          nativePause.call(v);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const next = cfg.enabled ? cfg.mode : 'any';
    mode = next === 'click' || next === 'hover' ? next : 'any';
    if (mode !== 'hover') {
      clearTimeout(dwellTimer);
      stopHoverVideo();
    }
    // Answer play() calls made before settings arrived.
    if (!configured) releaseHeld(false);
    // Guard off for this page: give the site its autoplay back.
    if (mode === 'any') restoreStrippedAutoplay();
    // Videos started without play() (autoplay attribute) before settings arrived.
    if (mode !== 'any') pauseUnallowedPlaying();
  }

  const opts = { capture: true, passive: true };
  window.addEventListener('pointerdown', onPointerDown, opts);
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener('pointermove', onPointerMove, opts);
  window.addEventListener('scroll', onScroll, opts);
  document.addEventListener('pointerout', onPointerLeaveWindow, opts);
  document.addEventListener('play', onPlayEvent, true);
  document.addEventListener('loadstart', onLoadStart, true);

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'gaf-extension' || data.type !== 'GAF_VIDEO_START_CONFIG') return;
      applyConfig(data);
    },
    false,
  );
})();
