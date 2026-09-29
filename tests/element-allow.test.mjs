import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALLOW_ATTR,
  NOT_ALLOWED,
  addAllowRule,
  removeAllowRule,
  allowSelectorsForHost,
  formatAllowRules,
  parseAllowRules,
  normalizeAllowRules,
  pickAllowTarget,
  syncAllowMarks,
  isAllowedElement,
  MAX_ALLOW_RULES,
} from '../src/core/element-allow.mjs';
import { MODERATE_CSS, STRICT_CSS } from '../src/core/css-motion.mjs';
import { normalizeSettings, buildExportPack, parseImportPack } from '../src/core/settings.mjs';
import { freezeAnimatedImageElement, freezeVideoElement } from '../src/core/freeze-media.mjs';
import { shouldSkipAnimation } from '../src/core/scripted-motion.mjs';

test('rules round-trip through uBlock-style text', () => {
  const text = [
    '! comment lines are ignored',
    'www.Example.com#@#figure.hero > img',
    '',
    'news.example#@#.ticker',
    'news.example#@#.ticker', // duplicate
    'not a rule',
    'bad.example#@#.x { color: red }', // style block refused
  ].join('\n');
  const rules = parseAllowRules(text);
  assert.deepEqual(rules, [
    { host: 'example.com', selector: 'figure.hero > img' },
    { host: 'news.example', selector: '.ticker' },
  ]);
  assert.equal(formatAllowRules(rules), 'example.com#@#figure.hero > img\nnews.example#@#.ticker');
});

test('add / remove rules and match subdomains only', () => {
  let rules = addAllowRule([], 'news.example', 'img.hero');
  rules = addAllowRule(rules, 'news.example', 'img.hero');
  rules = addAllowRule(rules, 'other.example', '.x');
  assert.equal(rules.length, 2);
  assert.deepEqual(allowSelectorsForHost(rules, 'www.news.example'), ['img.hero']);
  assert.deepEqual(allowSelectorsForHost(rules, 'm.news.example'), ['img.hero']);
  assert.deepEqual(allowSelectorsForHost(rules, 'notnews.example'), []);
  rules = removeAllowRule(rules, 'news.example', 'img.hero');
  assert.deepEqual(allowSelectorsForHost(rules, 'news.example'), []);
});

test('rule list is capped', () => {
  const many = Array.from({ length: MAX_ALLOW_RULES + 20 }, (_, i) => ({ host: 'a.example', selector: `.c${i}` }));
  assert.equal(normalizeAllowRules(many).length, MAX_ALLOW_RULES);
});

test('settings keep allow rules, and export/import carries them', () => {
  const s = normalizeSettings({
    allowRules: [{ host: 'WWW.A.example', selector: ' .x ' }, { host: 'b.example', selector: '.y{}' }, 'junk'],
  });
  assert.deepEqual(s.allowRules, [{ host: 'a.example', selector: '.x' }]);
  const pack = parseImportPack(JSON.stringify(buildExportPack(s, [])));
  assert.deepEqual(pack.settings.allowRules, [{ host: 'a.example', selector: '.x' }]);
  assert.deepEqual(normalizeSettings({}).allowRules, []);
});

function el(tag, attrs = {}, parent = null) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    dataset: {},
    attrs: { ...attrs },
    parentElement: parent,
    nextElementSibling: null,
    hasAttribute(n) { return n in this.attrs; },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    closest(sel) {
      // Supports the selectors element-allow / freeze-media use.
      for (let n = this; n; n = n.parentElement) {
        if (sel === '[data-gaf-allow]' && n.hasAttribute('data-gaf-allow')) return n;
        const tags = sel.split(',').map((t) => t.trim().toUpperCase());
        if (sel !== '[data-gaf-allow]' && tags.includes(n.tagName)) return n;
      }
      return null;
    },
  };
  return node;
}

test('right-clicking a frozen GIF canvas targets the hidden <img>', () => {
  const figure = el('figure');
  const canvas = el('canvas', {}, figure);
  canvas.dataset.gafFreezeCanvas = 'true';
  const img = el('img', {}, figure);
  canvas.nextElementSibling = img;
  assert.equal(pickAllowTarget(canvas), img);
});

test('a caption inside a <picture> resolves to the picture; plain elements stay put', () => {
  const picture = el('picture');
  const img = el('img', {}, picture);
  assert.equal(pickAllowTarget(img), picture);
  const div = el('div');
  assert.equal(pickAllowTarget(div), div);
  assert.equal(pickAllowTarget(null), null);
});

test('syncAllowMarks marks matches, unmarks removed rules, ignores bad selectors', () => {
  const a = el('div');
  const b = el('div');
  const byId = { '.a': [a], '.b': [b] };
  const doc = {
    querySelectorAll(sel) {
      if (sel === '[data-gaf-allow]') return [a, b].filter((n) => n.hasAttribute(ALLOW_ATTR));
      if (sel === ':::bad') throw new Error('SyntaxError');
      return byId[sel] || [];
    },
  };
  assert.deepEqual(syncAllowMarks(doc, ['.a', ':::bad']), [a]);
  assert.equal(a.hasAttribute(ALLOW_ATTR), true);
  assert.deepEqual(syncAllowMarks(doc, ['.a']), [], 'already marked is not re-added');
  syncAllowMarks(doc, ['.b']);
  assert.equal(a.hasAttribute(ALLOW_ATTR), false, 'rule removed → unmarked');
  assert.equal(b.hasAttribute(ALLOW_ATTR), true);
  assert.equal(isAllowedElement(b), true);
});

test('media freeze and scripted-motion pause skip allowed elements', () => {
  const card = el('div');
  card.setAttribute(ALLOW_ATTR, '');
  const img = el('img', { src: 'https://cdn.example/loop.gif' }, card);
  Object.assign(img, { src: 'https://cdn.example/loop.gif', complete: true, naturalWidth: 400, naturalHeight: 300, parentNode: card });
  assert.equal(freezeAnimatedImageElement(img), false);
  assert.equal(img.dataset.gafFrozen, undefined);

  const video = el('video', {}, card);
  assert.equal(freezeVideoElement(video), false);

  const anim = { effect: { target: el('span', {}, card) } };
  assert.equal(shouldSkipAnimation(anim), true);
});

test('motion CSS excludes allowed subtrees in both the core and early copies', () => {
  for (const css of [MODERATE_CSS, STRICT_CSS]) {
    assert.ok(css.includes(NOT_ALLOWED), 'kill rules skip [data-gaf-allow] subtrees');
  }
  const early = readFileSync(new URL('../src/content/early.js', import.meta.url), 'utf8');
  const count = (src) => src.split(NOT_ALLOWED).length - 1;
  const core = readFileSync(new URL('../src/core/css-motion.mjs', import.meta.url), 'utf8');
  assert.equal(count(early), count(core));
  assert.ok(count(core) >= 6);
});

test('options page round-trips allow rules (saving options must not wipe them)', () => {
  const src = readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');
  assert.match(src, /allowRules:\s*parseAllowRules\(/);
  assert.match(src, /formatAllowRules\(s\.allowRules\)/);
});
