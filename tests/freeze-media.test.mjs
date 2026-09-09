import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnimatedImageUrl,
  isLazyPlaceholderImage,
  freezeAnimatedImageElement,
  freezeMediaIn,
  freezePreviewVideoElement,
  freezeVideoElement,
  isMediaInsideInteractiveChrome,
  isLayoutCriticalVideo,
  looksLikeAutoplayThumbnailStrict,
  restoreFrozenMedia,
  allowVideoPlay,
  reconcileFrozenImages,
} from '../src/core/freeze-media.mjs';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(v) {
    this.values.add(v);
  }
  remove(v) {
    this.values.delete(v);
  }
  contains(v) {
    return this.values.has(v);
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.parentNode = null;
    this.nextSibling = null;
    this.children = [];
    this.width = 0;
    this.height = 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.loadCount = 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((item) => item.trim().toUpperCase());
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (selectors.includes(child.tagName)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  load() {
    this.loadCount += 1;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, reference) {
    child.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index !== -1) siblings.splice(index, 1);
    this.parentNode = null;
  }
  closest() {
    return null;
  }
}

function fakeDocument() {
  return {
    canvases: [],
    createElement(tagName) {
      const element = new FakeElement(tagName);
      if (tagName === 'canvas') {
        element.getContext = () => ({
          drawImage: (...args) => {
            element.drawArgs = args;
          },
        });
        this.canvases.push(element);
      }
      return element;
    },
  };
}

test('GIF URLs are animated; plain JPEG is not', () => {
  assert.equal(isAnimatedImageUrl('https://cdn.test/a.GIF?x=1'), true);
  assert.equal(isAnimatedImageUrl('https://cdn.test/a.jpg'), false);
  // data: GIF is a lazy-load spacer by default — not treated as freezable animation
  assert.equal(isAnimatedImageUrl('data:image/gif;base64,xx'), false);
  assert.equal(isAnimatedImageUrl('data:image/gif;base64,xx', { allowDataGif: true }), true);
});

test('lazy placeholder data-GIF is not frozen (av-avis regression)', () => {
  const document = fakeDocument();
  const parent = new FakeElement('a');
  const img = new FakeElement('img');
  img.src = 'data:image/gif;base64,R0lGODlhEAAJAIAAAP///wAAACH5BAEAAAAALAAAAAAQAAkAAAIKhI+py+0Po5yUFQA7';
  img.currentSrc = img.src;
  img.naturalWidth = 16;
  img.naturalHeight = 9;
  img.complete = true;
  parent.appendChild(img);

  assert.equal(isLazyPlaceholderImage(img, img.src), true);
  assert.equal(freezeAnimatedImageElement(img, { document }), false);
  assert.equal(img.dataset.gafFrozen, undefined);
  assert.equal(parent.children.length, 1);
});

test('src swap from frozen GIF placeholder restores real photo', () => {
  const document = fakeDocument();
  const parent = new FakeElement('a');
  const img = new FakeElement('img');
  // Simulate a previously-bad freeze (as older GAF did)
  img.src = 'https://vcdn.polarismedia.no/abc?fit=crop&w=800';
  img.currentSrc = img.src;
  img.naturalWidth = 800;
  img.naturalHeight = 400;
  img.complete = true;
  img.dataset.gafFrozen = 'image';
  img.dataset.gafFrozenSrc = 'data:image/gif;base64,R0lGODlhEAAJAIAAAP///wAAACH5';
  img.dataset.gafCanvasInserted = 'true';
  img.style.display = 'none';
  const canvas = new FakeElement('canvas');
  canvas.dataset.gafFreezeCanvas = 'true';
  parent.appendChild(canvas);
  parent.appendChild(img);

  const n = reconcileFrozenImages(parent, { document });
  assert.equal(n, 1);
  assert.equal(img.dataset.gafFrozen, undefined);
  assert.equal(img.style.display, '');
});

test('modern formats only when includeModern + hints', () => {
  assert.equal(isAnimatedImageUrl('https://cdn.test/photo.webp'), false);
  assert.equal(
    isAnimatedImageUrl('https://cdn.test/teaser-anim.webp', { includeModern: true }),
    true
  );
});

test('freezes GIF via canvas snapshot', () => {
  const document = fakeDocument();
  const parent = new FakeElement('a');
  const img = new FakeElement('img');
  img.src = 'https://cdn.test/teaser.gif';
  img.currentSrc = img.src;
  img.naturalWidth = 100;
  img.naturalHeight = 50;
  parent.appendChild(img);

  assert.equal(freezeAnimatedImageElement(img, { document }), true);
  assert.equal(parent.children[0].tagName, 'CANVAS');
  assert.equal(img.style.display, 'none');
  assert.equal(img.dataset.gafFrozen, 'image');
});

test('strict autoplay heuristic requires autoplay-like signals', () => {
  const quiet = new FakeElement('video');
  quiet.src = 'https://cdn.test/a.mp4';
  quiet.setAttribute('src', quiet.src);
  assert.equal(looksLikeAutoplayThumbnailStrict(quiet), false);

  const noisy = new FakeElement('video');
  noisy.autoplay = true;
  noisy.muted = true;
  noisy.loop = true;
  noisy.setAttribute('autoplay', '');
  noisy.setAttribute('muted', '');
  noisy.setAttribute('loop', '');
  assert.equal(looksLikeAutoplayThumbnailStrict(noisy), true);
});

test('full-bleed marketing hero is paused in place, sources kept (wayve.ai regression)', () => {
  // wayve.ai homepage: <section class="feb_2026_hero promo promo-a"> is 100vh,
  // background:transparent / color:#fff, child
  //   <video loop autoplay muted playsinline src="…HERO….mp4">
  // Heuristic freeze used to strip src → empty 100vh hole, white text on white body.
  const section = new FakeElement('section');
  section.className = 'feb_2026_hero promo promo-a margins-none';
  section.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0 });
  section.clientWidth = 1200;
  section.clientHeight = 800;

  const video = new FakeElement('video');
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.src = 'https://cdn.test/WAYVE_HERO_Web.V32.mp4';
  video.setAttribute('src', video.src);
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('loop', '');
  video.setAttribute('playsinline', '');
  video.pause = () => {
    video.paused = true;
  };
  video.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0 });
  video.clientWidth = 1200;
  video.clientHeight = 800;
  section.appendChild(video);

  const view = { innerWidth: 1200, innerHeight: 800 };
  assert.equal(isLayoutCriticalVideo(video, view), true);
  assert.equal(looksLikeAutoplayThumbnailStrict(video), true);
  assert.equal(freezeVideoElement(video, { strictHeuristic: true, view }), true);
  assert.equal(video.dataset.gafFrozen, 'video');
  assert.equal(video.dataset.gafKeepSource, '1');
  assert.equal(video.getAttribute('src'), 'https://cdn.test/WAYVE_HERO_Web.V32.mp4');
  assert.equal(video.autoplay, false);
  assert.equal(video.loop, false);
  assert.equal(video.hasAttribute('autoplay'), false);
  assert.equal(video.hasAttribute('loop'), false);

  // Later passes must not strip either (page JS often calls play() again)
  assert.equal(freezeVideoElement(video, { strictHeuristic: true, view }), false);
  assert.equal(video.getAttribute('src'), 'https://cdn.test/WAYVE_HERO_Web.V32.mp4');
});

test('strips looping autoplay video sources', () => {
  const video = new FakeElement('video');
  video.autoplay = true;
  video.loop = true;
  video.src = 'https://cdn.test/thumb.mp4';
  video.setAttribute('src', video.src);
  video.pause = () => {};
  const source = new FakeElement('source');
  source.setAttribute('src', 'https://cdn.test/thumb.webm');
  video.appendChild(source);

  assert.equal(freezeVideoElement(video), true);
  assert.equal(video.getAttribute('src'), null);
  assert.equal(source.getAttribute('src'), null);
  assert.equal(video.getAttribute('preload'), 'none');
});

test('small looping feed thumbnail still has sources stripped', () => {
  const video = new FakeElement('video');
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.src = 'https://cdn.test/feed-thumb.mp4';
  video.setAttribute('src', video.src);
  video.setAttribute('autoplay', '');
  video.setAttribute('loop', '');
  video.setAttribute('muted', '');
  video.pause = () => {};
  video.getBoundingClientRect = () => ({ width: 320, height: 180, top: 400, left: 40 });
  video.clientWidth = 320;
  video.clientHeight = 180;

  const view = { innerWidth: 1200, innerHeight: 800 };
  assert.equal(isLayoutCriticalVideo(video, view), false);
  assert.equal(freezeVideoElement(video, { strictHeuristic: true, view }), true);
  assert.equal(video.getAttribute('src'), null);
  assert.equal(video.dataset.gafKeepSource, undefined);
});

test('does not freeze video inside dialog / photo viewer (X.com lightbox regression)', () => {
  const video = new FakeElement('video');
  video.autoplay = true;
  video.muted = true;
  video.loop = true;
  video.src = 'https://cdn.test/thumb.mp4';
  video.setAttribute('src', video.src);
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('loop', '');
  video.pause = () => {};
  // Pretend we are under X media viewer chrome
  video.closest = (sel) => (String(sel).includes('[aria-modal="true"]') ? { id: 'viewer' } : null);

  assert.equal(isMediaInsideInteractiveChrome(video), true);
  assert.equal(freezeVideoElement(video, { strictHeuristic: true }), false);
  assert.equal(video.dataset.gafFrozen, undefined);
  assert.equal(video.getAttribute('src'), 'https://cdn.test/thumb.mp4');
});

test('allowVideoPlay restores and marks user intent', () => {
  const video = new FakeElement('video');
  video.autoplay = true;
  video.loop = true;
  video.src = 'https://cdn.test/thumb.mp4';
  video.setAttribute('src', video.src);
  video.pause = () => {};
  freezeVideoElement(video);
  allowVideoPlay(video);
  assert.equal(video.dataset.gafUserPlay, '1');
  assert.equal(video.dataset.gafFrozen, undefined);
  assert.equal(video.getAttribute('src'), 'https://cdn.test/thumb.mp4');
});

test('freezeMediaIn respects freezeVideos flag', () => {
  const root = new FakeElement('main');
  const video = new FakeElement('video');
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.setAttribute('autoplay', '');
  video.src = 'https://cdn.test/a.mp4';
  video.setAttribute('src', video.src);
  video.pause = () => {};
  root.appendChild(video);

  const off = freezeMediaIn(root, { freezeImages: false, freezeVideos: false });
  assert.equal(off.videos, 0);
  assert.equal(video.dataset.gafFrozen, undefined);

  const on = freezeMediaIn(root, {
    freezeImages: false,
    freezeVideos: true,
    strictHeuristic: true,
  });
  assert.equal(on.videos, 1);
  assert.equal(video.dataset.gafFrozen, 'video');
});

test('preview-video custom element is hidden and src stripped', () => {
  const preview = new FakeElement('preview-video');
  preview.setAttribute('src', 'https://cdn.test/p.mp4');
  preview.style.display = 'block';
  preview.style.setProperty = (k, v) => {
    preview.style[k] = v;
  };
  assert.equal(freezePreviewVideoElement(preview), true);
  assert.equal(preview.style.display, 'none');
  assert.equal(preview.getAttribute('src'), null);
  restoreFrozenMedia([preview]);
  assert.equal(preview.getAttribute('src'), 'https://cdn.test/p.mp4');
});

test('VG preview-video re-freeze when src and play classes return', () => {
  const preview = new FakeElement('preview-video');
  preview.setAttribute(
    'src',
    'https://dd-vgtv.akamaized.net/vgtv/vod/2026/05/preview.mp4'
  );
  preview.className = '_video_1s4m1_78 preview-video-loaded preview-video-in-screen';
  preview.style.setProperty = (k, v) => {
    preview.style[k] = v;
  };
  assert.equal(freezePreviewVideoElement(preview), true);
  assert.equal(preview.getAttribute('src'), null);
  assert.equal(/preview-video-in-screen/.test(preview.className), false);

  // Site re-injects loop (common SPA / intersection callback)
  preview.setAttribute(
    'src',
    'https://dd-vgtv.akamaized.net/vgtv/vod/2026/05/preview.mp4'
  );
  preview.className = '_video_1s4m1_78 preview-video-loaded preview-video-in-screen';
  assert.equal(freezePreviewVideoElement(preview), true);
  assert.equal(preview.getAttribute('src'), null);
  assert.equal(/preview-video-loaded/.test(preview.className), false);
});