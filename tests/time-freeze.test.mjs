import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timeFreezeMainConfig,
  buildSnapshotHtml,
  FREEZE_HOST_ID,
  applyReadingSnapshot,
  removeReadingSnapshot,
  isFreezeActive,
  shouldStretchTimerDelay,
  computeStretchedDelay,
} from '../src/core/time-freeze.mjs';

test('timeFreezeMainConfig enables for slow/stop', () => {
  assert.equal(timeFreezeMainConfig({ timeFreezeMode: 'off' }).enabled, false);
  assert.equal(timeFreezeMainConfig({ timeFreezeMode: 'slow', timeFreezeSlowFactor: 50 }).factor, 50);
  assert.ok(timeFreezeMainConfig({ timeFreezeMode: 'stop', timeFreezeSlowFactor: 10 }).factor >= 200);
  assert.equal(timeFreezeMainConfig({ timeFreezeMode: 'slow' }, { enabled: false }).enabled, false);
  assert.equal(timeFreezeMainConfig({ timeFreezeMode: 'slow', timeFreezeMinMs: 1500 }).minMs, 1500);
});

test('short timers are not stretched (lazy-load safe)', () => {
  assert.equal(shouldStretchTimerDelay(0, 2000), false);
  assert.equal(shouldStretchTimerDelay(100, 2000), false);
  assert.equal(shouldStretchTimerDelay(500, 2000), false);
  assert.equal(shouldStretchTimerDelay(1999, 2000), false);
  assert.equal(shouldStretchTimerDelay(2000, 2000), true);
  assert.equal(shouldStretchTimerDelay(5000, 2000), true);

  assert.equal(computeStretchedDelay(100, { factor: 80, minMs: 2000 }), 100);
  assert.equal(computeStretchedDelay(5000, { factor: 80, minMs: 2000, mode: 'slow' }), 400000);
});

function fakeDocWithArticle() {
  const nodes = new Map();
  const classList = new Set();
  const children = [];
  const doc = {
    baseURI: 'https://www.telegraph.co.uk/news/story/',
    location: { href: 'https://www.telegraph.co.uk/news/story/' },
    documentElement: {
      cloneNode() {
        return {
          outerHTML: '<html><head></head><body><article>Long article text here.</article></body></html>',
          querySelectorAll() {
            return { forEach() {} };
          },
          querySelector() {
            return null;
          },
        };
      },
      appendChild(el) {
        children.push(el);
        if (el.id) nodes.set(el.id, el);
        return el;
      },
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
      },
    },
    body: {},
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        id: '',
        style: { cssText: '' },
        textContent: '',
        children: [],
        setAttribute() {},
        addEventListener() {},
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        remove() {
          nodes.delete(this.id);
          const i = children.indexOf(this);
          if (i >= 0) children.splice(i, 1);
        },
      };
      return el;
    },
    getElementById(id) {
      return nodes.get(id) || null;
    },
    _children: children,
    _nodes: nodes,
  };
  return doc;
}

test('buildSnapshotHtml strips scripts from clone', () => {
  const html = buildSnapshotHtml(fakeDocWithArticle());
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /article/i);
});

test('applyReadingSnapshot mounts host and remove clears it', () => {
  const doc = fakeDocWithArticle();
  const longBody = 'Article text goes here. '.repeat(20);
  const ok = applyReadingSnapshot(doc, {
    html: `<!DOCTYPE html><html><body><article>${longBody}</article></body></html>`,
  });
  assert.equal(ok, true);
  assert.equal(isFreezeActive(doc), true);
  assert.ok(doc.getElementById(FREEZE_HOST_ID));
  removeReadingSnapshot(doc);
  assert.equal(isFreezeActive(doc), false);
});
