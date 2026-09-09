import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cookieDomainFromHost,
  cookieUrlFromDetails,
  looksLikeMeterCookieName,
  removeDetailsForCookie,
  clearCookiesForPageUrl,
  shouldAutoMeterReset,
  shouldDisarmMeterOnPage,
  shouldEscalateMeterWipe,
  detectMeterWall,
  disarmMeterWall,
  measureArticleText,
  meterAutoStorageKey,
  METER_WALL_TEXT_RE,
  MIN_ARTICLE_CHARS_FOR_DISARM,
} from '../src/core/meter-reset.mjs';
import { normalizeSettings, effectiveHideRules } from '../src/core/settings.mjs';

test('cookieDomainFromHost strips www and multi-labels', () => {
  assert.equal(cookieDomainFromHost('www.spiked-online.com'), 'spiked-online.com');
  assert.equal(cookieDomainFromHost('spiked-online.com'), 'spiked-online.com');
  assert.equal(cookieDomainFromHost('a.b.example.com'), 'example.com');
  assert.equal(cookieDomainFromHost('www.telegraph.co.uk'), 'telegraph.co.uk');
});

test('looksLikeMeterCookieName matches common patterns', () => {
  assert.equal(looksLikeMeterCookieName('piano_id'), true);
  assert.equal(looksLikeMeterCookieName('free_article_count'), true);
  assert.equal(looksLikeMeterCookieName('session_id'), false);
  assert.equal(looksLikeMeterCookieName('wordpress_logged_in'), false);
});

test('cookieUrlFromDetails and removeDetailsForCookie', () => {
  const c = {
    name: 'meter',
    domain: '.spiked-online.com',
    path: '/',
    secure: true,
    storeId: '0',
  };
  assert.equal(cookieUrlFromDetails(c), 'https://spiked-online.com/');
  assert.deepEqual(removeDetailsForCookie(c), {
    url: 'https://spiked-online.com/',
    name: 'meter',
    storeId: '0',
  });
});

test('clearCookiesForPageUrl queries only the page URL, never a domain heuristic', async () => {
  const removed = [];
  const queries = [];
  const cookiesApi = {
    async getAll(query) {
      queries.push(query);
      if (query.url) {
        return [
          {
            name: 'meter_count',
            domain: '.spiked-online.com',
            path: '/',
            secure: true,
            storeId: '0',
          },
          {
            name: 'session',
            domain: 'www.spiked-online.com',
            path: '/',
            secure: true,
            storeId: '0',
          },
        ];
      }
      return [
        {
          name: 'sibling_shop',
          domain: 'shop.spiked-online.com',
          path: '/',
          secure: true,
          storeId: '0',
        },
      ];
    },
    async remove(details) {
      removed.push(details.name);
      return details;
    },
  };

  const all = await clearCookiesForPageUrl(
    'https://www.spiked-online.com/2026/07/18/example/',
    { mode: 'all', cookiesApi }
  );
  assert.equal(all.ok, true);
  assert.equal(all.removed, 2);
  assert.ok(all.names.includes('meter_count'));
  assert.ok(!all.names.includes('sibling_shop'));
  assert.equal(queries.length, 1);
  assert.equal(queries[0].url, 'https://www.spiked-online.com/2026/07/18/example/');
  assert.equal(queries[0].domain, undefined);

  removed.length = 0;
  queries.length = 0;
  const filtered = await clearCookiesForPageUrl(
    'https://www.spiked-online.com/2026/07/18/example/',
    { mode: 'meter-names', cookiesApi }
  );
  assert.equal(filtered.removed, 1);
  assert.deepEqual(filtered.names, ['meter_count']);
  assert.equal(queries[0].domain, undefined);
});

test('meterAutoStorageKey is per path, not one flag for the origin', () => {
  const a = meterAutoStorageKey('https://www.spiked-online.com/2026/07/18/one/');
  const b = meterAutoStorageKey('https://www.spiked-online.com/2026/07/18/two/');
  assert.notEqual(a, b);
  assert.match(a, /^gafMeterAutoDone:https:\/\/www\.spiked-online\.com\/2026\/07\/18\/one\/$/);
});

test('shouldAutoMeterReset only in auto mode on softwall articles', () => {
  const auto = normalizeSettings({
    meterResetEnabled: true,
    meterResetMode: 'auto',
    meterResetScope: 'softwall',
  });
  assert.equal(
    shouldAutoMeterReset(
      'https://www.spiked-online.com/2026/07/18/the-anne-widdecombe-investigation/',
      auto
    ),
    true
  );
  assert.equal(shouldAutoMeterReset('https://www.spiked-online.com/', auto), false);
  assert.equal(
    shouldAutoMeterReset(
      'https://www.spiked-online.com/2026/07/18/x/',
      normalizeSettings({ meterResetMode: 'manual' })
    ),
    false
  );
  assert.equal(
    shouldAutoMeterReset('https://example.com/news/story-here/', auto),
    false
  );
});

test('shouldEscalateMeterWipe requires two signals or a named adapter', () => {
  assert.equal(
    shouldEscalateMeterWipe({ wallDetected: false, disarmUseful: false, articleChars: 50 }),
    false
  );
  assert.equal(
    shouldEscalateMeterWipe({ selectorHit: true, textHit: false, strongSelector: false }),
    false
  );
  assert.equal(
    shouldEscalateMeterWipe({ selectorHit: false, textHit: true, strongSelector: false }),
    false
  );
  assert.equal(
    shouldEscalateMeterWipe({ wallDetected: true, disarmUseful: true, articleChars: 50 }),
    false
  );
  assert.equal(
    shouldEscalateMeterWipe({ selectorHit: true, textHit: true, strongSelector: false }),
    true
  );
  assert.equal(
    shouldEscalateMeterWipe({ strongSelector: true, selectorHit: true, textHit: false }),
    true
  );
});

test('detectMeterWall finds active paywall and text', () => {
  const el = {
    classList: { contains: (c) => c === 'active' || c === 'paywall' },
    getAttribute() {
      return null;
    },
    style: {},
  };
  const doc = {
    querySelectorAll(sel) {
      if (sel.includes('active') || sel.includes('paywall')) return [el];
      return [];
    },
    querySelector(sel) {
      return doc.querySelectorAll(sel)[0] || null;
    },
    defaultView: null,
    body: { innerText: '' },
  };
  const strong = detectMeterWall(doc);
  assert.equal(strong.detected, true);
  assert.equal(strong.strongSelector, true);
  assert.equal(shouldEscalateMeterWipe(strong), true);

  const textDoc = {
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    body: {
      innerText: "You've hit your monthly free article limit. Support us.",
    },
  };
  const textOnly = detectMeterWall(textDoc);
  assert.equal(textOnly.detected, true);
  assert.equal(textOnly.textHit, true);
  assert.equal(textOnly.selectorHit, false);
  assert.equal(shouldEscalateMeterWipe(textOnly), false);
  assert.ok(METER_WALL_TEXT_RE.test("You've hit your monthly free article limit"));

  const generic = {
    classList: { contains: () => false },
    getAttribute() {
      return null;
    },
    style: {},
  };
  const genericDoc = {
    querySelectorAll(sel) {
      if (sel.includes('metered')) return [generic];
      return [];
    },
    querySelector() {
      return null;
    },
    body: { innerText: 'Account settings' },
  };
  const genericOnly = detectMeterWall(genericDoc);
  assert.equal(genericOnly.selectorHit, true);
  assert.equal(genericOnly.strongSelector, false);
  assert.equal(genericOnly.textHit, false);
  assert.equal(shouldEscalateMeterWipe(genericOnly), false);
});

test('spiked-online.com is a default softwall host', () => {
  const s = normalizeSettings({});
  assert.equal(
    shouldAutoMeterReset(
      'https://www.spiked-online.com/2026/07/18/example-story/',
      normalizeSettings({ meterResetMode: 'auto' })
    ),
    true
  );
  assert.equal(
    shouldDisarmMeterOnPage(
      'https://www.spiked-online.com/2026/07/18/example-story/',
      normalizeSettings({})
    ),
    true
  );
});

test('disarmMeterWall hides Spiked gate and reports useful when body present', () => {
  const nodes = [];
  const gate = {
    classList: {
      _set: new Set(['gated-content-wrap', 'paywall', 'active']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
    },
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
  };
  nodes.push(gate);
  const article = {
    innerText:
      'The chilling murder of Ann Widdecombe has stunned the country. '.repeat(20),
    textContent: '',
    closest() {
      return null;
    },
  };
  const styleNodes = [];
  const doc = {
    querySelectorAll(sel) {
      if (sel.includes('gated-content') || sel.includes('paywall') || sel.includes('notice')) {
        return [gate];
      }
      if (sel.includes('article') || sel.includes('cms') || sel.includes('normal-article')) {
        return [article];
      }
      return [];
    },
    querySelector(sel) {
      const all = doc.querySelectorAll(sel);
      return all[0] || null;
    },
    getElementById() {
      return null;
    },
    createElement() {
      const el = {
        id: '',
        textContent: '',
        setAttribute() {},
      };
      styleNodes.push(el);
      return el;
    },
    head: {
      appendChild(el) {
        return el;
      },
    },
    documentElement: {},
    body: { innerText: article.innerText },
    defaultView: null,
  };

  const result = disarmMeterWall(doc);
  assert.ok(result.hidden >= 1);
  assert.ok(result.activeRemoved >= 1);
  assert.ok(result.articleChars >= MIN_ARTICLE_CHARS_FOR_DISARM);
  assert.equal(result.useful, true);
  assert.equal(gate.style.display, 'none');
  assert.equal(gate.classList.contains('active'), false);
});

test('default hide rules include Spiked gated-content wrap', () => {
  const rules = effectiveHideRules(normalizeSettings({}));
  assert.ok(rules.some((r) => r.includes('gated-content-wrap.paywall')));
});
