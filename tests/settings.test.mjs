import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings,
  normalizeHost,
  parseHostList,
  effectiveNewsHosts,
  resolveSitePolicy,
  shouldFreezeVideoOnPage,
  shouldFreezeImagesOnPage,
  shouldTimeFreezeOnPage,
  looksLikePlayerPage,
  looksLikeArticlePage,
  looksLikeGameOrPuzzlePage,
  looksLikeToolSpaPage,
  looksLikePaymentAuthPage,
  isToolSpaHost,
  isPaymentAuthHost,
  isQuizWidgetHost,
  looksLikeQuizWidgetPage,
  shouldPauseScriptedMotionOnPage,
  shouldApplyMotionOnPage,
  isFrontOrSectionRoot,
  DEFAULT_SETTINGS,
  DEFAULT_NEWS_HOSTS,
  buildExportPack,
  parseImportPack,
  effectiveHideRules,
} from '../src/core/settings.mjs';

test('normalizeHost strips www and lowercases', () => {
  assert.equal(normalizeHost('WWW.VG.NO'), 'vg.no');
  assert.equal(normalizeHost('www.tv2.no'), 'tv2.no');
});

test('parseHostList splits mixed separators', () => {
  assert.deepEqual(parseHostList('a.com, b.org\nc.net'), ['a.com', 'b.org', 'c.net']);
});

test('resolveSitePolicy respects master switch, deny, and exclusions', () => {
  assert.equal(resolveSitePolicy('https://vg.no/', { enabled: false }).active, false);
  assert.equal(
    resolveSitePolicy(
      'https://github.com/',
      { enabled: true },
      ['github.com']
    ).reason,
    'excluded'
  );
  assert.equal(
    resolveSitePolicy('https://noisy.example/', {
      enabled: true,
      denyHosts: ['noisy.example'],
    }).reason,
    'deny-list'
  );
});

test('legacy allowHosts still exclude', () => {
  assert.equal(
    resolveSitePolicy('https://broken.test/', {
      enabled: true,
      allowHosts: ['broken.test'],
    }).active,
    false
  );
});

test('news video policy freezes front and section roots only', () => {
  const s = normalizeSettings({
    enabled: true,
    videoPolicy: 'news',
    useDefaultNewsHosts: true,
  });
  assert.equal(shouldFreezeVideoOnPage('https://www.vg.no/', s), true);
  assert.equal(shouldFreezeVideoOnPage('https://www.vg.no/sport', s), true);
  assert.equal(
    shouldFreezeVideoOnPage('https://www.vg.no/sport/i/example/video-story', s),
    false
  );
  assert.equal(shouldFreezeVideoOnPage('https://www.youtube.com/watch?v=x', s), false);
});

test('heuristic video policy freezes most sites but not player pages', () => {
  const s = normalizeSettings({ enabled: true, videoPolicy: 'heuristic' });
  assert.equal(shouldFreezeVideoOnPage('https://example.test/news', s), true);
  assert.equal(shouldFreezeVideoOnPage('https://www.youtube.com/watch?v=x', s), false);
  assert.equal(shouldFreezeVideoOnPage('https://www.youtube.com/watch?v=32iH1WBJbJo', s), false);
});

test('looksLikePlayerPage covers YouTube host even without /watch path edge cases', () => {
  assert.equal(looksLikePlayerPage('https://www.youtube.com/watch?v=32iH1WBJbJo'), true);
  assert.equal(looksLikePlayerPage('https://youtu.be/32iH1WBJbJo'), true);
  assert.equal(looksLikePlayerPage('https://www.youtube.com/'), true);
  assert.equal(looksLikePlayerPage('https://music.youtube.com/watch?v=x'), true);
});

test('FilterBlade is a tool SPA — no motion pause / CSS motion kill', () => {
  const s = normalizeSettings({ enabled: true, pauseScriptedMotion: true, motionLevel: 'moderate' });
  assert.equal(looksLikeToolSpaPage('https://www.filterblade.xyz/?game=Poe1'), true);
  assert.equal(shouldPauseScriptedMotionOnPage('https://www.filterblade.xyz/?game=Poe1', s), false);
  assert.equal(shouldApplyMotionOnPage('https://www.filterblade.xyz/?game=Poe1', s), false);
  assert.equal(shouldPauseScriptedMotionOnPage('https://www.vg.no/', s), true);
});

test('Grok / x.ai is a tool SPA — settings modals must not be motion-killed', () => {
  const s = normalizeSettings({
    enabled: true,
    pauseScriptedMotion: true,
    motionLevel: 'moderate',
    timeFreezeMode: 'slow',
    timeFreezeScope: 'all',
  });
  assert.equal(looksLikeToolSpaPage('https://grok.x.ai/'), true);
  assert.equal(looksLikeToolSpaPage('https://x.ai/'), true);
  assert.equal(isToolSpaHost('grok.x.ai'), true);
  assert.equal(shouldPauseScriptedMotionOnPage('https://grok.x.ai/', s), false);
  assert.equal(shouldApplyMotionOnPage('https://grok.x.ai/', s), false);
  assert.equal(shouldTimeFreezeOnPage('https://grok.x.ai/', s), false);
});

test('X.com / Twitter is a tool SPA — compose/reply mask must not be unstuck or motion-killed', () => {
  const s = normalizeSettings({
    enabled: true,
    pauseScriptedMotion: true,
    motionLevel: 'moderate',
    freezeImages: true,
    videoPolicy: 'heuristic',
    timeFreezeMode: 'slow',
    timeFreezeScope: 'all',
  });
  assert.equal(looksLikeToolSpaPage('https://x.com/home'), true);
  assert.equal(looksLikeToolSpaPage('https://twitter.com/i/status/1'), true);
  assert.equal(isToolSpaHost('x.com'), true);
  assert.equal(isToolSpaHost('www.x.com'), true);
  assert.equal(isToolSpaHost('mobile.twitter.com'), true);
  // Unstick / motion / timers skipped (same path as FilterBlade)
  assert.equal(shouldPauseScriptedMotionOnPage('https://x.com/', s), false);
  assert.equal(shouldApplyMotionOnPage('https://x.com/', s), false);
  assert.equal(shouldTimeFreezeOnPage('https://x.com/', s), false);
  // Media freeze still active — GIFs / autoplay still get filtered
  assert.equal(shouldFreezeImagesOnPage('https://x.com/', s), true);
  assert.equal(shouldFreezeVideoOnPage('https://x.com/', s), true);
});

test('BankID / Morrow payment-auth hosts skip motion and timers, not GIF freeze', () => {
  const s = normalizeSettings({
    enabled: true,
    pauseScriptedMotion: true,
    motionLevel: 'moderate',
    freezeImages: true,
    videoPolicy: 'heuristic',
    timeFreezeMode: 'slow',
    timeFreezeScope: 'all',
  });
  assert.equal(isPaymentAuthHost('auth.bankid.no'), true);
  assert.equal(isPaymentAuthHost('cs.bankid.no'), true);
  assert.equal(isPaymentAuthHost('www.morrowbank.no'), true);
  assert.equal(isPaymentAuthHost('secure.morrowbank.com'), true);
  assert.equal(isPaymentAuthHost('starlink.com'), false);
  assert.equal(isPaymentAuthHost('vg.no'), false);
  assert.equal(looksLikePaymentAuthPage('https://auth.bankid.no/auth/realms/prod'), true);
  assert.equal(looksLikePaymentAuthPage('https://www.starlink.com/checkout'), false);
  // Auth client: do not freeze motion/timers (challenge UI). Ads elsewhere still filtered.
  assert.equal(shouldPauseScriptedMotionOnPage('https://auth.bankid.no/', s), false);
  assert.equal(shouldApplyMotionOnPage('https://cs.bankid.no/', s), false);
  assert.equal(shouldTimeFreezeOnPage('https://www.morrowbank.no/3ds', s), false);
  assert.equal(shouldPauseScriptedMotionOnPage('https://www.starlink.com/checkout', s), true);
  assert.equal(shouldApplyMotionOnPage('https://www.starlink.com/checkout', s), true);
  // Media freeze still on — this is not "turn GAF off"
  assert.equal(shouldFreezeImagesOnPage('https://auth.bankid.no/', s), true);
});

test('Tirsdagsquizen widget host skips unstick/motion/timers; newspaper article stays filtered', () => {
  const s = normalizeSettings({
    enabled: true,
    pauseScriptedMotion: true,
    motionLevel: 'moderate',
    freezeImages: true,
    videoPolicy: 'heuristic',
    timeFreezeMode: 'slow',
    timeFreezeScope: 'all',
  });
  const widget = 'https://quiz-43ns.onrender.com/widget.html?newspaper=askoyveringen';
  assert.equal(isQuizWidgetHost('quiz-43ns.onrender.com'), true);
  assert.equal(isQuizWidgetHost('www.quiz-43ns.onrender.com'), true);
  assert.equal(isQuizWidgetHost('other-app.onrender.com'), false);
  assert.equal(isQuizWidgetHost('av-avis.no'), false);
  assert.equal(looksLikeQuizWidgetPage(widget), true);
  assert.equal(looksLikeGameOrPuzzlePage(widget), true);
  assert.equal(shouldPauseScriptedMotionOnPage(widget, s), false);
  assert.equal(shouldApplyMotionOnPage(widget, s), false);
  assert.equal(shouldTimeFreezeOnPage(widget, s), false);
  // Media freeze still on — not a wholesale GAF-off for the iframe
  assert.equal(shouldFreezeImagesOnPage(widget, s), true);

  const article = 'https://www.av-avis.no/nyheter/n/XM1mox/snart-er-det-halloween';
  assert.equal(looksLikeQuizWidgetPage(article), false);
  assert.equal(shouldApplyMotionOnPage(article, s), true);
  assert.equal(shouldPauseScriptedMotionOnPage(article, s), true);
  // Default softwall scope still must not stretch timers on local papers
  const soft = normalizeSettings({ timeFreezeMode: 'slow', timeFreezeScope: 'softwall' });
  assert.equal(shouldTimeFreezeOnPage(article, soft), false);
});

test('defaults are ON including time freeze slow and element hiding', () => {
  const s = normalizeSettings({});
  assert.equal(s.enabled, true);
  assert.equal(s.freezeImages, true);
  assert.equal(s.videoPolicy, 'heuristic');
  assert.equal(s.timeFreezeMode, 'slow');
  assert.equal(s.elementHiding, true);
  assert.equal(s.version, 2);
  assert.ok(effectiveHideRules(s).length > 0);
});

test('default hide rules do not use bare class*=paywall (Schibsted/BT content)', () => {
  const s = normalizeSettings({});
  const rules = effectiveHideRules(s);
  // Bare [class*="paywall" i] would hide every BT paragraph: class="paywall hyperion-css-…"
  const bare = rules.filter(
    (r) =>
      r.includes('[class*="paywall" i]') ||
      r.includes("[class*='paywall' i]") ||
      r === '[class*="paywall"]' ||
      r === "[class*='paywall']"
  );
  assert.deepEqual(bare, [], `unexpected bare paywall rule(s): ${bare.join(' | ')}`);
  // Still hide explicit wall chrome
  assert.ok(rules.some((r) => r.includes('paywall-modal') || r.includes('paywall-overlay')));
});

test('time freeze respects exclusions, player pages, and softwall scope', () => {
  const s = normalizeSettings({ timeFreezeMode: 'slow', timeFreezeScope: 'softwall' });
  assert.equal(shouldTimeFreezeOnPage('https://www.telegraph.co.uk/news/x', s), true);
  // Local papers must not get global timer stretch (lazy-load images)
  assert.equal(shouldTimeFreezeOnPage('https://www.av-avis.no/', s), false);
  assert.equal(shouldTimeFreezeOnPage('https://www.youtube.com/watch?v=x', s), false);
  assert.equal(
    shouldTimeFreezeOnPage('https://www.telegraph.co.uk/news/x', s, ['telegraph.co.uk']),
    false
  );

  const everywhere = normalizeSettings({ timeFreezeMode: 'slow', timeFreezeScope: 'all' });
  assert.equal(shouldTimeFreezeOnPage('https://www.av-avis.no/', everywhere), true);
});

test('time freeze skips games/puzzles on softwall hosts (Wordle regression)', () => {
  const s = normalizeSettings({ timeFreezeMode: 'slow', timeFreezeScope: 'softwall' });
  // nytimes.com is a softwall host — articles still freeze
  assert.equal(
    shouldTimeFreezeOnPage('https://www.nytimes.com/2026/07/19/world/example.html', s),
    true
  );
  // Wordle win toast uses ~2–3s timers; stretch would stall "Magnificent" for minutes
  assert.equal(
    shouldTimeFreezeOnPage('https://www.nytimes.com/games/wordle/index.html', s),
    false
  );
  assert.equal(
    shouldTimeFreezeOnPage('https://www.nytimes.com/games/connections', s),
    false
  );
  assert.equal(
    shouldTimeFreezeOnPage('https://www.nytimes.com/crosswords/game/mini', s),
    false
  );
  assert.equal(
    shouldTimeFreezeOnPage('https://www.washingtonpost.com/crossword-puzzles/daily/', s),
    false
  );
  // scope=all must still spare games
  const everywhere = normalizeSettings({ timeFreezeMode: 'slow', timeFreezeScope: 'all' });
  assert.equal(
    shouldTimeFreezeOnPage('https://www.nytimes.com/games/wordle/index.html', everywhere),
    false
  );
  assert.equal(shouldTimeFreezeOnPage('https://example.test/news/story', everywhere), true);
});

test('looksLikeGameOrPuzzlePage detects game hosts and paths', () => {
  assert.equal(
    looksLikeGameOrPuzzlePage('https://www.nytimes.com/games/wordle/index.html'),
    true
  );
  assert.equal(looksLikeGameOrPuzzlePage('https://games.example.com/app'), true);
  assert.equal(looksLikeGameOrPuzzlePage('https://www.nytimes.com/section/world'), false);
  assert.equal(
    looksLikeGameOrPuzzlePage('https://www.nytimes.com/2026/07/19/world/example.html'),
    false
  );
});

test('looksLikeArticlePage detects article-like paths', () => {
  assert.equal(looksLikeArticlePage('https://www.telegraph.co.uk/'), false);
  assert.equal(
    looksLikeArticlePage('https://www.telegraph.co.uk/news/2024/01/01/some-story/'),
    true
  );
  // Multi-segment game paths must not count as articles (stop-mode snapshot bait)
  assert.equal(
    looksLikeArticlePage('https://www.nytimes.com/games/wordle/index.html'),
    false
  );
  assert.equal(looksLikePlayerPage('https://site.test/video/123'), true);
  assert.equal(isFrontOrSectionRoot('https://bt.no/nyheter'), true);
});

test('effectiveNewsHosts merges defaults and extras', () => {
  const hosts = effectiveNewsHosts({
    useDefaultNewsHosts: true,
    newsHosts: ['localpaper.test'],
  });
  assert.ok(hosts.includes('vg.no'));
  assert.ok(hosts.includes('telegraph.co.uk'));
  assert.ok(hosts.includes('localpaper.test'));
  assert.ok(DEFAULT_NEWS_HOSTS.includes('bbc.com'));
});

test('images follow exclusion list', () => {
  const s = normalizeSettings({ enabled: true, freezeImages: true });
  assert.equal(shouldFreezeImagesOnPage('https://example.com/x', s, ['example.com']), false);
  assert.equal(shouldFreezeImagesOnPage('https://other.com/x', s), true);
});

test('meter reset defaults are meter-names and no durable wipe', () => {
  assert.equal(DEFAULT_SETTINGS.meterResetCookieMode, 'meter-names');
  assert.equal(DEFAULT_SETTINGS.meterResetClearDurableStorage, false);
  const s = normalizeSettings({});
  assert.equal(s.meterResetCookieMode, 'meter-names');
  assert.equal(s.meterResetClearDurableStorage, false);
  const kept = normalizeSettings({ meterResetCookieMode: 'all', meterResetClearDurableStorage: true });
  assert.equal(kept.meterResetCookieMode, 'all');
  assert.equal(kept.meterResetClearDurableStorage, true);
});

test('export/import filter pack round-trips', () => {
  const s = normalizeSettings({ motionLevel: 'strict' });
  const pack = buildExportPack(s, [{ host: 'x.test', status: 'open', id: '1', createdAt: 't' }]);
  const parsed = parseImportPack(JSON.stringify(pack));
  assert.equal(parsed.settings.motionLevel, 'strict');
  assert.equal(parsed.exclusions.length, 1);
  assert.equal(DEFAULT_SETTINGS.timeFreezeMode, 'slow');
});
