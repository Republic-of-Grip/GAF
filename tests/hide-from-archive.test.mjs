import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hideRuleCandidatesFromEntry,
  pickBestHideCandidate,
  addGlobalHideRule,
  addHostHideRule,
  markArchiveEntryRuleAdded,
} from '../src/core/hide-from-archive.mjs';
import { normalizeSettings } from '../src/core/settings.mjs';

const paywallEntry = {
  id: 'arc_1',
  tagName: 'div',
  host: 'telegraph.co.uk',
  idAttr: 'paywall-modal',
  className: 'SoftWall Overlay paywall-v2',
  selectorHint: 'div#paywall-modal',
  attributes: {
    id: 'paywall-modal',
    'data-testid': 'reg-wall',
    role: 'dialog',
    class: 'SoftWall Overlay paywall-v2',
  },
  outerHtml: '<div id="paywall-modal"></div>',
  hints: [],
};

test('candidates prefer id and annoyance classes', () => {
  const list = hideRuleCandidatesFromEntry(paywallEntry);
  assert.ok(list.length >= 2);
  assert.ok(list.some((c) => c.selector === '#paywall-modal'));
  assert.ok(list.some((c) => c.selector.includes('data-testid')));
  assert.ok(list.some((c) => /paywall/i.test(c.selector)));
});

test('pickBestHideCandidate chooses strong id rule', () => {
  const best = pickBestHideCandidate(paywallEntry);
  assert.ok(best);
  assert.equal(best.strength, 'strong');
  assert.match(best.selector, /paywall-modal/);
});

test('bare tag-only entries yield no dangerous global candidates', () => {
  const list = hideRuleCandidatesFromEntry({
    tagName: 'div',
    className: '',
    selectorHint: 'div',
    attributes: {},
  });
  assert.equal(list.length, 0);
});

test('addGlobalHideRule appends once and enables elementHiding', () => {
  const base = normalizeSettings({ elementHiding: false, hideRules: [] });
  const first = addGlobalHideRule(base, '#paywall-modal');
  assert.equal(first.added, true);
  assert.equal(first.settings.elementHiding, true);
  assert.deepEqual(first.settings.hideRules, ['#paywall-modal']);

  const second = addGlobalHideRule(first.settings, '#paywall-modal');
  assert.equal(second.added, false);
  assert.equal(second.alreadyHad, true);
  assert.equal(second.settings.hideRules.length, 1);
});

test('addHostHideRule writes siteCss for host', () => {
  const base = normalizeSettings({ siteCss: {}, customCss: false });
  const result = addHostHideRule(base, 'www.telegraph.co.uk', '.SoftWall');
  assert.equal(result.added, true);
  assert.equal(result.settings.customCss, true);
  assert.match(result.settings.siteCss['telegraph.co.uk'], /\.SoftWall/);
  assert.match(result.settings.siteCss['telegraph.co.uk'], /display:none/);

  const again = addHostHideRule(result.settings, 'telegraph.co.uk', '.SoftWall');
  assert.equal(again.alreadyHad, true);
});

test('markArchiveEntryRuleAdded stamps note and hideRuleAdded', () => {
  const marked = markArchiveEntryRuleAdded(paywallEntry, {
    selector: '#paywall-modal',
    scope: 'global',
  });
  assert.equal(marked.hideRuleAdded.selector, '#paywall-modal');
  assert.equal(marked.hideRuleAdded.scope, 'global');
  assert.match(marked.note, /Hide rule added/);
});
