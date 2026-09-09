import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cssForMotionLevel,
  applyMotionStyle,
  removeMotionStyle,
  STYLE_ELEMENT_ID,
  MODERATE_CSS,
  STRICT_CSS,
} from '../src/core/css-motion.mjs';

function fakeDoc() {
  const classList = new Set();
  const nodes = new Map();
  const doc = {
    documentElement: {
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        has: (c) => classList.has(c),
      },
    },
    head: {
      appendChild(el) {
        nodes.set(el.id, el);
        return el;
      },
    },
    getElementById(id) {
      return nodes.get(id) || null;
    },
    createElement() {
      return {
        id: '',
        textContent: '',
        setAttribute() {},
        remove() {
          nodes.delete(this.id);
        },
      };
    },
    _classList: classList,
    _nodes: nodes,
  };
  return doc;
}

test('cssForMotionLevel maps levels', () => {
  assert.equal(cssForMotionLevel('off'), '');
  assert.equal(cssForMotionLevel('moderate'), MODERATE_CSS);
  assert.equal(cssForMotionLevel('strict'), STRICT_CSS);
});

test('moderate CSS does not force near-zero animation duration on everything', () => {
  // Regression: av-avis.no blank tiles — duration:0.01ms + pause froze image reveals
  assert.equal(/animation-duration:\s*0\.01ms/.test(MODERATE_CSS), false);
  assert.equal(/animation-play-state:\s*paused/.test(MODERATE_CSS), false);
  assert.match(MODERATE_CSS, /img/);
  assert.match(MODERATE_CSS, /opacity:\s*revert-layer/);
});

test('motion CSS protects dialog/overlay chrome (ditur grey-screen regression)', () => {
  assert.match(MODERATE_CSS, /\[role="dialog"\]/);
  assert.match(MODERATE_CSS, /\[role="overlay"\]/);
  assert.match(MODERATE_CSS, /\.backdrop/);
  assert.match(MODERATE_CSS, /#authentication-popup/);
  assert.match(MODERATE_CSS, /#nav-backdrop/);
  assert.match(MODERATE_CSS, /#cookie-form/);
  assert.match(MODERATE_CSS, /\.bg-image-overlay/);
  assert.match(MODERATE_CSS, /iframe\[src\*=["']bankid\.no["']\]/);
  assert.match(MODERATE_CSS, /morrowbank\.no/);
  assert.match(STRICT_CSS, /\[role="dialog"\]/);
  assert.match(MODERATE_CSS, /animation-play-state:\s*running/);
  assert.match(STRICT_CSS, /transition-duration:\s*revert-layer/);
});

test('dialog protect does not force UA-visible hide properties (power.no white dialogs)', () => {
  // Isolate the dialog block (after img protect) so img { opacity: revert-layer } is allowed
  const dialogBlock = MODERATE_CSS.slice(MODERATE_CSS.indexOf('html.gaf-motion-active dialog'));
  assert.match(dialogBlock, /html\.gaf-motion-active dialog/);
  assert.equal(/opacity:\s*revert-layer/.test(dialogBlock), false);
  assert.equal(/visibility:\s*revert-layer/.test(dialogBlock), false);
  assert.equal(/transform:\s*revert-layer/.test(dialogBlock), false);
  assert.equal(/pointer-events:\s*revert-layer/.test(dialogBlock), false);
});

test('strict CSS still protects img opacity', () => {
  assert.match(STRICT_CSS, /img/);
  assert.match(STRICT_CSS, /opacity:\s*1/);
});

test('applyMotionStyle injects and removeMotionStyle clears', () => {
  const doc = fakeDoc();
  assert.equal(applyMotionStyle(doc, 'moderate'), true);
  assert.ok(doc.getElementById(STYLE_ELEMENT_ID));
  assert.ok(doc._classList.has('gaf-motion-active'));
  removeMotionStyle(doc);
  assert.equal(doc.getElementById(STYLE_ELEMENT_ID), null);
  assert.equal(doc._classList.has('gaf-motion-active'), false);
});
