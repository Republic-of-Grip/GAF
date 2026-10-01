import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeSettings, DEFAULT_SETTINGS, VIDEO_PLAY_ON } from '../src/core/settings.mjs';

const SCRIPT = readFileSync(new URL('../src/content/video-start-main.js', import.meta.url), 'utf8');

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
      for (let n = this; n; n = n.parentElement) {
        if (sel === '[data-gaf-allow]' && n.attrs?.['data-gaf-allow'] !== undefined) return n;
      }
      return null;
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
  const context = {
    window,
    document,
    HTMLMediaElement,
    HTMLVideoElement,
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
    click(x, y, target = {}) {
      fire('window', 'pointerdown', { isTrusted: true, button: 0, clientX: x, clientY: y, target });
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
  const card = { querySelectorAll: () => [v], parentElement: null };
  const button = {
    getAttribute: (n) => (n === 'aria-label' ? 'Play' : null),
    textContent: '',
    querySelectorAll: () => [],
    parentElement: card,
  };
  button.closest = () => button;
  page.config(true, 'click');
  page.click(500, 500, button);
  assert.equal(await result(v.play()), 'native-play');
});

test('an unrelated button (Like, Reply) does not arm a video', async () => {
  const page = makePage();
  const v = page.addVideo({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const card = { querySelectorAll: () => [v], parentElement: null };
  const like = { getAttribute: (n) => (n === 'aria-label' ? 'Like' : null), textContent: '', parentElement: card };
  like.closest = () => like;
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
