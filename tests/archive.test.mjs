import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectorHintFor,
  buildEscapeHints,
  serializeElement,
  prependArchive,
} from '../src/core/archive.mjs';

class FakeEl {
  constructor(tag, props = {}) {
    this.tagName = tag.toUpperCase();
    this.id = props.id || '';
    this.className = props.className || '';
    this.attributes = props.attributes || [];
    this.src = props.src || '';
    this.currentSrc = props.currentSrc || props.src || '';
    this.outerHTML = props.outerHTML || `<${tag}></${tag}>`;
    this.innerText = props.innerText || '';
    this.textContent = props.innerText || '';
    this.dataset = props.dataset || {};
    this.parentElement = props.parentElement || null;
    this.style = props.style || {};
    this.complete = props.complete !== false;
    this.naturalWidth = props.naturalWidth ?? 10;
    this.naturalHeight = props.naturalHeight ?? 10;
  }
  getAttribute(name) {
    if (name === 'src') return this.src || null;
    const a = this.attributes.find?.((x) => x.name === name);
    return a ? a.value : null;
  }
}

test('selectorHintFor includes id when present', () => {
  const el = new FakeEl('div', { id: 'paywall' });
  assert.match(selectorHintFor(el), /#paywall/);
});

test('buildEscapeHints flags non-gif images and cross-origin', () => {
  const el = new FakeEl('img', {
    src: 'https://cdn.other.test/anim.webp',
    currentSrc: 'https://cdn.other.test/anim.webp',
  });
  const hints = buildEscapeHints(el, 'https://news.test/a');
  const codes = hints.map((h) => h.code);
  assert.ok(codes.includes('img-not-gif-url'));
  assert.ok(
    codes.includes('cross-origin-img') ||
      codes.includes('remote-img-url') ||
      codes.includes('page-url')
  );
});

test('serializeElement produces archive record', () => {
  const el = new FakeEl('video', {
    className: 'autoplay-thumb',
    outerHTML: '<video class="autoplay-thumb"></video>',
    innerText: '',
  });
  const entry = serializeElement(el, 'https://www.example.com/story', 'Story');
  assert.equal(entry.tagName, 'video');
  assert.equal(entry.host, 'example.com');
  assert.ok(Array.isArray(entry.hints));
  assert.ok(entry.hints.length > 0);
});

test('prependArchive caps size', () => {
  const first = serializeElement(new FakeEl('div', { id: 'a' }), 'https://a.test/', 'A');
  let list = prependArchive([], first);
  for (let i = 0; i < 250; i++) {
    list = prependArchive(list, serializeElement(new FakeEl('span'), `https://x.test/${i}`, 'x'));
  }
  assert.ok(list.length <= 200);
});
