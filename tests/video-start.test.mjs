import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeSettings, DEFAULT_SETTINGS, VIDEO_PLAY_ON } from '../src/core/settings.mjs';

const SCRIPT = readFileSync(new URL('../src/content/video-start-main.js', import.meta.url), 'utf8');

/** closest() for the selectors the guard uses: allow marks, controls, viewers. */
function closestIn(start, sel) {
  for (let n = start; n; n = n.parentElement) {
    if (sel.includes('[data-gaf-allow]') && n.attrs?.['data-gaf-allow'] !== undefined) return n;
    if (sel.includes('button') && n.interactive) return n;
    if (sel.includes('dialog') && n.dialog) return n;
  }
  return null;
}

/** A plain DOM-ish node (card, button, dialog) for the guard to walk. */
export function node({ label = null, interactive = false, dialog = false, rect = null, parent = null, videos = [] } = {}) {
  const n = {
    interactive,
    dialog,
    parentElement: parent,
    attrs: {},
    textContent: '',
    getAttribute: (k) => (k === 'aria-label' ? label : null),
    getBoundingClientRect: () => rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    querySelectorAll: () => videos,
    closest: (sel) => closestIn(n, sel),
  };
  return n;
}

/**
 * Minimal page for the MAIN-world guard: media element classes with a
 * "native" play/pause, event listeners, and controllable timers.
 */
function makePage() {
  const listeners = { window: {}, document: {} };
  const timers = [];
  const videos = [];

  class HTMLMediaElement {
    constructor() {
      this.paused = true;
      this.autoplay = false;
      this.srcObject = null;
      this.dataset = {};
      this.attrs = {};
      this.parentElement = null;
      this.tagName = 'AUDIO';
    }
    play() {
      this.paused = false;
      return Promise.resolve('native-play');
    }
    pause() {
      this.paused = true;
    }
    closest(sel) {
      return closestIn(this, sel);
    }
    dispatchEvent(ev) {
      (this.events ||= []).push(ev.type);
      return true;
    }
    getAttribute(n) {
      return this.attrs[n] ?? null;
    }
  }
  class HTMLVideoElement extends HTMLMediaElement {
    constructor(rect = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 }) {
      super();
      this.tagName = 'VIDEO';
      this.rect = rect;
    }
    getBoundingClientRect() {
      return this.rect;
    }
  }

  const on = (bucket) => (type, fn) => {
    (listeners[bucket][type] ||= []).push(fn);
  };
  const document = {
    activeElement: null,
    addEventListener: on('document'),
    querySelectorAll: (sel) => (sel === 'video' ? videos : []),
  };
  const window = { addEventListener: on('window') };
  class CustomEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const context = {
    window,
    document,
    HTMLMediaElement,
    HTMLVideoElement,
    CustomEvent,
    DOMException,
    Promise,
    Date,
    Error,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
  };
  window.window = window;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);

  const fire = (bucket, type, event) => (listeners[bucket][type] || []).forEach((fn) => fn(event));
  return {
    HTMLVideoElement,
    HTMLMediaElement,
    videos,
    document,
    timers,
    addVideo(rect) {
      const v = new HTMLVideoElement(rect);
      videos.push(v);
      return v;
    },
    config(enabled, mode) {
      fire('window', 'message', {
        source: window,
        data: { source: 'gaf-extension', type: 'GAF_VIDEO_START_CONFIG', enabled, mode },
      });
    },
    click(x, y, target = null) {
      fire('window', 'click', { isTrusted: true, button: 0, clientX: x, clientY: y, target });
    },
    pointerdown(x, y, target = null) {
      fire('window', 'pointerdown', { isTrusted: true, button: 0, clientX: x, clientY: y, target });
    },
    move(x, y) {
      fire('window', 'pointermove', { clientX: x, clientY: y, pointerType: 'mouse' });
    },
    scroll() {
      fire('window', 'scroll', {});
    },
    runTimers() {
      const due = timers.splice(0);
      due.forEach((t) => t.fn());
    },
    key(key) {
      fire('window', 'keydown', { isTrusted: true, key });
    },
    loadstart(v) {
      fire('document', 'loadstart', { target: v });
    },
  };
}

const result = (p) => p.then((v) => v, (e) => e.name);

test('click mode: script play() is refused like the browser autoplay block', async () => {
  const page = makePage();
  const v = page.addVideo();
  page.config(true, 'click');
  assert.equal(await result(v.play()), 'NotAllowedError');
  assert.equal(v.paused, true);
});

test('clicking on the video (or an overlay above it) lets it play', async () => {
  const page = makePage();
  const v = page.addVideo();
  const other = page.addVideo({ left: 0, top: 400, right: 320, bottom: 580, width: 320, height: 180 });
  page.config(true, 'click');
  page.click(100, 100);
  assert.equal(await result(v.play()), 'native-play');
  assert.equal(await result(other.play()), 'NotAllowedError', 'only the clicked video');
  // Still allowed later (player re-calls play after buffering / scrolling back).
  assert.equal(await result(v.play()), 'native-play');
});

test('a play button next to the video arms that video', async () => {
  const page = makePage();
  const v = page.addVideo({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const card = node({ videos: [v] });
  const button = node({ label: 'Play', interactive: true, parent: card });
  page.config(true, 'click');
  page.click(500, 500, button);
  assert.equal(await result(v.play()), 'native-play');
});

test('an unrelated button (Like, Reply) does not arm a video', async () => {
  const page = makePage();
  const v = page.addVideo({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const card = node({ videos: [v] });
  const like = node({ label: 'Like', interactive: true, parent: card });
  page.config(true, 'click');
  page.click(500, 500, like);
  assert.equal(await result(v.play()), 'NotAllowedError');
});

test('keyboard: Space on a focused video plays it; typing does not', async () => {
  const page = makePage();
  const v = page.addVideo();
  page.config(true, 'click');
  page.document.activeElement = { tagName: 'TEXTAREA', isContentEditable: false };
  page.key(' ');
  assert.equal(await result(v.play()), 'NotAllowedError');
  page.document.activeElement = v;
  page.key(' ');
  assert.equal(await result(v.play()), 'native-play');
});

test('never blocked: live streams, allowed elements, user-started videos, audio', async () => {
  const page = makePage();
  page.config(true, 'click');
  const live = page.addVideo();
  live.srcObject = {};
  assert.equal(await result(live.play()), 'native-play');
  const allowedCard = { attrs: { 'data-gaf-allow': '' }, parentElement: null };
  const inside = page.addVideo();
  inside.parentElement = allowedCard;
  assert.equal(await result(inside.play()), 'native-play');
  const started = page.addVideo();
  started.dataset.gafUserPlay = '1';
  assert.equal(await result(started.play()), 'native-play');
  const audio = new page.HTMLMediaElement();
  assert.equal(await result(audio.play()), 'native-play');
});

test('guard disabled (GAF off, excluded, paused, player site) or "site decides": everything plays', async () => {
  for (const [enabled, mode] of [[false, 'click'], [true, 'any']]) {
    const page = makePage();
    const v = page.addVideo();
    page.config(enabled, mode);
    assert.equal(await result(v.play()), 'native-play');
  }
});

test('play() before settings arrive is held, then answered by the settings', async () => {
  const page = makePage();
  const blocked = page.addVideo();
  const pending = result(blocked.play());
  assert.equal(blocked.paused, true, 'not started while settings are pending');
  page.config(true, 'click');
  assert.equal(await pending, 'NotAllowedError');

  const off = makePage();
  const v = off.addVideo();
  const p2 = result(v.play());
  off.config(false, 'click');
  assert.equal(await p2, 'native-play', 'GAF off for the page: the held play() goes through');
});

test('if settings never arrive, held play() calls go through (fail open)', async () => {
  const page = makePage();
  const v = page.addVideo();
  const pending = result(v.play());
  const hold = page.timers.find((t) => t.ms === 2500);
  assert.ok(hold, 'hold timeout scheduled');
  hold.fn();
  assert.equal(await pending, 'native-play');
});

test('autoplay attribute is switched off at loadstart, and given back when the guard is off', () => {
  const page = makePage();
  const v = page.addVideo();
  v.autoplay = true;
  page.config(true, 'click');
  page.loadstart(v);
  assert.equal(v.autoplay, false);
  page.config(true, 'any');
  assert.equal(v.autoplay, true);
});

test('settings: videoPlayOn defaults to click and rejects unknown values', () => {
  assert.equal(DEFAULT_SETTINGS.videoPlayOn, 'click');
  assert.deepEqual(VIDEO_PLAY_ON, ['click', 'hover', 'any']);
  assert.equal(normalizeSettings({}).videoPlayOn, 'click');
  assert.equal(normalizeSettings({ videoPlayOn: 'hover' }).videoPlayOn, 'hover');
  assert.equal(normalizeSettings({ videoPlayOn: 'sometimes' }).videoPlayOn, 'click');
});

test('wiring: manifest runs the guard in the page; early.js sends settings with exemptions; UI exposes it', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
  assert.ok(main.js.includes('src/content/video-start-main.js'));
  assert.equal(main.run_at, 'document_start');
  const early = readFileSync(new URL('../src/content/early.js', import.meta.url), 'utf8');
  assert.match(early, /GAF_VIDEO_START_CONFIG/);
  assert.match(early, /postVideoStartConfig\(false, 'any'\)/, 'inactive pages turn the guard off');
  assert.match(early, /!isMediaPlayerHost\(host\)[\s\S]{0,80}!isPopup[\s\S]{0,80}!isPaymentAuthHost\(host\)/);
  for (const f of ['../src/popup/popup.js', '../src/options/options.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /videoPlayOn: \$\('videoPlayOn'\)\.value/, `${f} saves the setting`);
  }
});

// ---- Review fixes (Cursor review on #19) --------------------------------

const BOX = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };

test('a press that never becomes a click (touch scroll, drag) arms nothing', async () => {
  const page = makePage();
  const v = page.addVideo(BOX);
  page.config(true, 'click');
  page.pointerdown(100, 100, v);
  assert.equal(await result(v.play()), 'NotAllowedError');
});

test('Like / mute / CTA sitting on top of the video do not arm it', async () => {
  for (const label of ['Like', 'Mute', 'Unmute', 'Shop now', 'Video settings', 'Start a conversation']) {
    const page = makePage();
    const v = page.addVideo(BOX);
    const card = node({ videos: [v] });
    const control = node({ label, interactive: true, parent: card, rect: { left: 280, top: 140, right: 310, bottom: 170, width: 30, height: 30 } });
    page.config(true, 'click');
    page.click(290, 150, control);
    assert.equal(await result(v.play()), 'NotAllowedError', label);
  }
});

test('unlabelled icon button: small one inside the box does not arm; a big overlay does', async () => {
  const small = makePage();
  const v1 = small.addVideo(BOX);
  const icon = node({ interactive: true, rect: { left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 } });
  small.config(true, 'click');
  small.click(20, 20, icon);
  assert.equal(await result(v1.play()), 'NotAllowedError');

  const big = makePage();
  const v2 = big.addVideo(BOX);
  const overlay = node({ interactive: true, rect: BOX });
  big.config(true, 'click');
  big.click(150, 90, overlay);
  assert.equal(await result(v2.play()), 'native-play');
});

test('play words are whole words: playButton and "Toggle Play" count, "display" does not', async () => {
  for (const [label, expected] of [['playButton', 'native-play'], ['Toggle Play', 'native-play'], ['Spill av', 'native-play'], ['Display options', 'NotAllowedError']]) {
    const page = makePage();
    const v = page.addVideo({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    const card = node({ videos: [v] });
    const control = node({ label, interactive: true, parent: card });
    page.config(true, 'click');
    page.click(500, 500, control);
    assert.equal(await result(v.play()), expected, label);
  }
});

test('keyboard only arms the focused video or a focused play button', async () => {
  const page = makePage();
  const v = page.addVideo(BOX);
  const card = node({ videos: [v] });
  page.config(true, 'click');
  page.document.activeElement = node({ label: 'Like', interactive: true, parent: card });
  page.key(' ');
  assert.equal(await result(v.play()), 'NotAllowedError', 'Space on Like');
  page.document.activeElement = node({ videos: [v] }); // body-like: contains the one video
  page.key('k');
  assert.equal(await result(v.play()), 'NotAllowedError', 'k with the page focused');
  page.document.activeElement = node({ label: 'Play', interactive: true, parent: card });
  page.key('Enter');
  assert.equal(await result(v.play()), 'native-play', 'Enter on Play');
});

test('a video opened in a viewer right after a click inherits it; other videos do not', async () => {
  const page = makePage();
  const feed = page.addVideo(BOX);
  page.config(true, 'click');
  page.click(100, 100, feed);
  const dialog = node({ dialog: true });
  const inViewer = page.addVideo(BOX);
  inViewer.parentElement = dialog;
  assert.equal(await result(inViewer.play()), 'native-play');
  const elsewhere = page.addVideo({ left: 0, top: 900, right: 320, bottom: 1080, width: 320, height: 180 });
  assert.equal(await result(elsewhere.play()), 'NotAllowedError');
});

test('hover: resting starts the video, marks it user-started and asks GAF to unfreeze; leaving undoes that', async () => {
  const page = makePage();
  const v = page.addVideo(BOX);
  page.config(true, 'hover');
  page.move(100, 100);
  page.runTimers();
  assert.equal(v.paused, false, 'playing after the dwell');
  assert.equal(v.dataset.gafUserPlay, '1');
  assert.deepEqual(v.events, ['gaf-user-play']);
  page.move(600, 600);
  assert.equal(v.paused, true, 'paused when the pointer leaves');
  assert.equal(v.dataset.gafUserPlay, undefined, 'hover mark removed');
  assert.equal(await result(v.play()), 'NotAllowedError', 'page cannot restart it');
});

test('hover: a pointer resting on a video while the page scrolls does not start it', () => {
  const page = makePage();
  const v = page.addVideo(BOX);
  page.config(true, 'hover');
  page.move(100, 100);
  page.scroll();
  page.runTimers();
  assert.equal(v.paused, true);
});

test('held autoplay is marked so freeze-media records it and Leave-alone can restart it', async () => {
  const page = makePage();
  const v = page.addVideo(BOX);
  v.autoplay = true;
  page.config(true, 'click');
  page.loadstart(v);
  assert.equal(v.dataset.gafAutoplayHeld, '1');
  page.config(true, 'any');
  assert.equal(v.dataset.gafAutoplayHeld, undefined, 'marker cleared when autoplay is given back');

  const { freezeVideoElement } = await import('../src/core/freeze-media.mjs');
  const frozen = {
    dataset: { gafAutoplayHeld: '1' },
    autoplay: false,
    loop: true,
    muted: true,
    controls: false,
    hasAttribute: (a) => a === 'loop' || a === 'muted',
    getAttribute: () => null,
    removeAttribute() {},
    setAttribute() {},
    pause() {},
    load() {},
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => BOX,
  };
  freezeVideoElement(frozen, { strictHeuristic: true });
  assert.equal(frozen.dataset.gafOriginalAutoplay, 'true');

  const main = readFileSync(new URL('../src/content/main.js', import.meta.url), 'utf8');
  assert.match(main, /video\[data-gaf-autoplay-held\][\s\S]{0,200}isAllowedElement[\s\S]{0,200}video\.autoplay = true/);
  assert.match(main, /addEventListener\('gaf-user-play', userPlayRequestHandler, true\)/);
});

test('single-video pages skip the guard; feeds and listing pages keep it', () => {
  const early = readFileSync(new URL('../src/content/early.js', import.meta.url), 'utf8');
  const lit = early.match(/SINGLE_VIDEO_PATH_RE = (\/.+\/[a-z]*);/)[1];
  const re = vm.runInNewContext(lit);
  for (const p of ['/someone/status/123/video/1', '/watch', '/embed/abc', '/player/9', '/show/episode/3', '/video/12345-title'])
    assert.equal(re.test(p), true, p);
  for (const p of ['/home', '/someone/media', '/videos', '/someone/status/123', '/live', '/'])
    assert.equal(re.test(p), false, p);
  assert.match(early, /!SINGLE_VIDEO_PATH_RE\.test\(videoPath\)/);
});
