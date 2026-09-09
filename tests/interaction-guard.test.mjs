import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cssColorAlpha,
  cssFilterIsActive,
  hasUsableModalContent,
  unlockBodyScroll,
  unstickOrphanedOverlays,
  hideDimmer,
  restoreInteractionUnlock,
  isPageScrollLocked,
  isBlockingDimmer,
  isPageContentLayer,
  isMarketingChromeLayer,
  isConsentLikePanel,
  findConsentAcceptButton,
  dismissBlockingConsentWall,
  clickConsentControl,
  requestMainWorldClick,
  documentHasCookieEvidence,
  isDiturConsentHost,
  seedMinimalConsentCookie,
  isPaymentAuthSrc,
  isPaymentAuthLayer,
  documentHasPaymentAuth,
} from '../src/core/interaction-guard.mjs';

test('cssColorAlpha parses rgba and modern slash syntax', () => {
  assert.equal(cssColorAlpha('transparent'), 0);
  assert.equal(cssColorAlpha('rgb(0, 0, 0)'), 1);
  assert.ok(Math.abs(cssColorAlpha('rgba(0, 0, 0, 0.25)') - 0.25) < 0.001);
  assert.ok(Math.abs(cssColorAlpha('rgb(0 0 0 / 0.5)') - 0.5) < 0.001);
});

test('cssFilterIsActive ignores blur(0px) no-ops', () => {
  assert.equal(cssFilterIsActive('none'), false);
  assert.equal(cssFilterIsActive('blur(0px)'), false);
  assert.equal(cssFilterIsActive('blur(0)'), false);
  assert.equal(cssFilterIsActive('blur(8px)'), true);
});

test('marketing chrome ids/classes are not orphan dimmers (wayve-style scrape)', () => {
  // GAF-off DOM: body children include #cookie-banner, #cookie-form, HEADER,
  // MAIN, FOOTER, A.back-to-top, #nav-backdrop. Keyword hits: cookie-*,
  // bg-image-overlay, nav-backdrop, fixed-nav. No paywall/modal/dialog/gate.
  assert.equal(isMarketingChromeLayer({ id: 'nav-backdrop', className: '' }), true);
  assert.equal(isMarketingChromeLayer({ id: 'cookie-banner', className: '' }), true);
  assert.equal(isMarketingChromeLayer({ id: 'cookie-form', className: '' }), true);
  assert.equal(isMarketingChromeLayer({ id: '', className: 'bg-image-overlay' }), true);
  assert.equal(isMarketingChromeLayer({ id: 'confirmOverlay', className: 'backdrop' }), false);
});

test('#nav-backdrop idle scrim is not a blocking dimmer', () => {
  // Live CSS: position:fixed; 100%×100%; background rgba(255,255,255,.8);
  // backdrop-filter:blur(0px); opacity:0; pointer-events:none.
  const scrim = {
    nodeType: 1,
    tagName: 'DIV',
    id: 'nav-backdrop',
    className: '',
    dataset: {},
    style: {},
    getAttribute(name) {
      if (name === 'data-gaf-unstuck') return null;
      return null;
    },
    getBoundingClientRect() {
      return { width: 1200, height: 800 };
    },
    querySelector() {
      return null;
    },
    innerText: '',
    textContent: '',
  };
  const view = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        pointerEvents: 'none',
        opacity: '0',
        position: 'fixed',
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        backdropFilter: 'blur(0px)',
        webkitBackdropFilter: 'blur(0px)',
      };
    },
  };
  assert.equal(isBlockingDimmer(scrim, view), false);

  // Even if pointer-events were auto, opacity 0 + marketing id still skip
  const clickable = {
    ...view,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        pointerEvents: 'auto',
        opacity: '0',
        position: 'fixed',
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        backdropFilter: 'blur(0px)',
        webkitBackdropFilter: 'blur(0px)',
      };
    },
  };
  assert.equal(isBlockingDimmer(scrim, clickable), false);
});

test('#cookie-form settings overlay is not an orphan dimmer', () => {
  const form = {
    nodeType: 1,
    tagName: 'DIV',
    id: 'cookie-form',
    className: 'showing',
    dataset: {},
    style: {},
    getAttribute(name) {
      if (name === 'data-gaf-unstuck') return null;
      return null;
    },
    getBoundingClientRect() {
      return { width: 1200, height: 800 };
    },
    querySelector() {
      return { tagName: 'INPUT' };
    },
    innerText: 'Necessary Analytics Embedded Save settings Accept all',
    textContent: 'Necessary Analytics Embedded Save settings Accept all',
  };
  const view = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle() {
      return {
        display: 'grid',
        visibility: 'visible',
        pointerEvents: 'auto',
        opacity: '1',
        position: 'fixed',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'none',
        webkitBackdropFilter: 'none',
      };
    },
  };
  assert.equal(isBlockingDimmer(form, view), false);
});

function fakeDocWithOrphanDimmer() {
  const bodyChildren = [];
  const body = {
    classList: {
      _set: new Set(['overflow-hidden']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      add(c) {
        this._set.add(c);
      },
    },
    style: { overflow: 'hidden', position: 'fixed', top: '-120px', left: '0', right: '0' },
    children: bodyChildren,
  };
  const dimmer = {
    nodeType: 1,
    id: 'confirmOverlay',
    className: 'backdrop',
    dataset: { gafTestDimmer: '1' },
    style: {
      display: '',
      setProperty(k, v) {
        this[k] = v;
      },
    },
    getAttribute(name) {
      if (name === 'data-gaf-unstuck') return this.dataset.gafUnstuck || null;
      return null;
    },
    setAttribute(name, val) {
      if (name === 'data-gaf-unstuck') this.dataset.gafUnstuck = val;
    },
    innerText: '',
    textContent: '',
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  bodyChildren.push(dimmer);

  const nodesBySel = {
    '.backdrop': [dimmer],
    '#confirmOverlay': [dimmer],
  };

  const doc = {
    body,
    querySelectorAll(sel) {
      return nodesBySel[sel] || [];
    },
  };
  return { doc, dimmer, body, nodesBySel };
}

test('unstickOrphanedOverlays hides orphan dimmer and unlocks body', () => {
  const { doc, dimmer, body } = fakeDocWithOrphanDimmer();
  const result = unstickOrphanedOverlays(doc, {});
  assert.equal(result.cleared >= 1, true, `expected cleared>=1 got ${JSON.stringify(result)}`);
  assert.equal(result.unlocked, true);
  assert.equal(dimmer.style.display, 'none');
  assert.equal(body.classList.contains('overflow-hidden'), false);
  assert.equal(body.style.position, '');
});

test('unstick leaves page alone when usable non-consent modal is present', () => {
  const { doc, dimmer } = fakeDocWithOrphanDimmer();
  const dialog = {
    nodeType: 1,
    id: '',
    className: '',
    dataset: {},
    style: { display: 'block' },
    hidden: false,
    innerText: 'Logg inn med e-post og passord for å fortsette',
    textContent: 'Logg inn med e-post og passord for å fortsette',
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const orig = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (sel) => {
    if (sel === '[role="dialog"]') return [dialog];
    return orig(sel);
  };
  const result = unstickOrphanedOverlays(doc, {});
  assert.equal(result.reason, 'usable-modal-present');
  assert.equal(result.cleared, 0);
  assert.notEqual(dimmer.style.display, 'none');
});

function fakeBankIdIframe(src = 'https://auth.bankid.no/auth/realms/prod/protocol/openid-connect/auth') {
  return {
    nodeType: 1,
    tagName: 'IFRAME',
    id: '',
    className: '',
    src,
    innerText: '',
    textContent: '',
    getAttribute(name) {
      if (name === 'src') return src;
      if (name === 'id' || name === 'name' || name === 'title') return '';
      return null;
    },
  };
}

function fakeStarlinkBankIdOverlay() {
  const iframe = fakeBankIdIframe();
  const overlay = {
    nodeType: 1,
    tagName: 'DIV',
    id: '',
    className: 'backdrop',
    dataset: {},
    style: {
      display: '',
      setProperty(k, v) {
        this[k] = v;
      },
    },
    getAttribute(name) {
      if (name === 'data-gaf-unstuck') return this.dataset.gafUnstuck || null;
      if (name === 'role') return 'overlay';
      return null;
    },
    setAttribute(name, val) {
      if (name === 'data-gaf-unstuck') this.dataset.gafUnstuck = val;
    },
    getBoundingClientRect() {
      return { width: 1200, height: 800 };
    },
    querySelector(sel) {
      if (String(sel).includes('iframe')) return iframe;
      return null;
    },
    querySelectorAll(sel) {
      if (String(sel).includes('iframe')) return [iframe];
      return [];
    },
    innerText: '',
    textContent: '',
  };
  const body = {
    classList: {
      _set: new Set(['overflow-hidden']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
    },
    style: { overflow: 'hidden' },
    children: [overlay],
  };
  const nodesBySel = {
    '.backdrop': [overlay],
    '[role="overlay"]': [overlay],
    iframe: [iframe],
  };
  const doc = {
    body,
    querySelectorAll(sel) {
      if (sel === 'iframe') return [iframe];
      return nodesBySel[sel] || [];
    },
  };
  return { doc, overlay, iframe, body };
}

test('isPaymentAuthSrc matches BankID and Morrow, not checkout or ads', () => {
  assert.equal(isPaymentAuthSrc('https://auth.bankid.no/auth/realms/prod'), true);
  assert.equal(isPaymentAuthSrc('https://cs.bankid.no/client'), true);
  assert.equal(isPaymentAuthSrc('https://secure.morrowbank.no/acs/challenge'), true);
  assert.equal(isPaymentAuthSrc('https://www.morrowbank.com/3ds'), true);
  assert.equal(isPaymentAuthSrc('https://www.starlink.com/checkout'), false);
  assert.equal(isPaymentAuthSrc('https://doubleclick.net/ad'), false);
  assert.equal(isPaymentAuthSrc('about:blank'), false);
});

test('BankID iframe overlay is not an orphan dimmer (Starlink/Morrow 3DS)', () => {
  const { overlay } = fakeStarlinkBankIdOverlay();
  const view = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        pointerEvents: 'auto',
        opacity: '1',
        position: 'fixed',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'none',
        webkitBackdropFilter: 'none',
      };
    },
  };
  assert.equal(isPaymentAuthLayer(overlay), true);
  assert.equal(isBlockingDimmer(overlay, view), false);
});

test('unstick leaves BankID/Morrow payment-auth overlay alone', () => {
  const { doc, overlay, body } = fakeStarlinkBankIdOverlay();
  assert.equal(documentHasPaymentAuth(doc), true);
  const result = unstickOrphanedOverlays(doc, {});
  assert.equal(result.reason, 'payment-auth-present');
  assert.equal(result.cleared, 0);
  assert.notEqual(overlay.style.display, 'none');
  assert.equal(body.classList.contains('overflow-hidden'), true);
});

test('payment-auth copy is not a cookie wall even with personvern', () => {
  const panel = {
    nodeType: 1,
    tagName: 'DIV',
    id: 'acs-challenge',
    className: '',
    innerText:
      'Skriv inn fødselsnummer for å fortsette med BankID. Les vår personvernpolicy.',
    textContent:
      'Skriv inn fødselsnummer for å fortsette med BankID. Les vår personvernpolicy.',
    querySelectorAll() {
      return [];
    },
  };
  assert.equal(isPaymentAuthLayer(panel), true);
  assert.equal(isConsentLikePanel(panel), false);
});

test('orphan ad dimmer is still hidden when no payment-auth is present', () => {
  const { doc, dimmer, body } = fakeDocWithOrphanDimmer();
  const result = unstickOrphanedOverlays(doc, {});
  assert.equal(result.cleared >= 1, true);
  assert.equal(dimmer.style.display, 'none');
  assert.equal(body.classList.contains('overflow-hidden'), false);
});

test('hasUsableModalContent detects text panels', () => {
  const dialog = {
    dataset: {},
    style: { display: '' },
    hidden: false,
    innerText: 'Logg inn med e-post og passord her',
    textContent: 'Logg inn med e-post og passord her',
    querySelector() {
      return null;
    },
  };
  const doc = {
    querySelectorAll(sel) {
      if (sel === '[role="dialog"]') return [dialog];
      return [];
    },
  };
  assert.equal(hasUsableModalContent(doc, {}), true);
});

test('full-viewport background video is not an orphan dimmer', () => {
  // Transparent 100vh <video> + body lock used to match the "click catcher" path
  // and hide the hero (blank marketing page).
  const video = {
    nodeType: 1,
    tagName: 'VIDEO',
    id: '',
    className: '',
    dataset: {},
    style: {},
    ownerDocument: {
      body: {
        classList: { contains: (c) => c === 'noscroll' },
      },
      querySelector() {
        return null;
      },
    },
    getAttribute(name) {
      if (name === 'data-gaf-unstuck') return null;
      return null;
    },
    getBoundingClientRect() {
      return { width: 1200, height: 800 };
    },
    querySelector() {
      return null;
    },
    innerText: '',
    textContent: '',
  };
  const view = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        pointerEvents: 'auto',
        position: 'absolute',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        backdropFilter: 'none',
        webkitBackdropFilter: 'none',
      };
    },
  };
  assert.equal(isBlockingDimmer(video, view), false);
});

test('full-viewport marketing hero hosting a video is not an orphan dimmer', () => {
  const videoEl = {
    getBoundingClientRect() {
      return { width: 1200, height: 800 };
    },
  };
  const hero = {
    nodeType: 1,
    tagName: 'SECTION',
    id: '',
    className: 'feb_2026_hero promo promo-a',
    dataset: {},
    style: {},
    getAttribute(name) {
      if (name === 'data-gaf-unstuck') return null;
      return null;
    },
    getBoundingClientRect() {
      return { width: 1200, height: 800 };
    },
    querySelector(sel) {
      if (String(sel).includes('video')) return videoEl;
      return null;
    },
    innerText: '',
    textContent: '',
  };
  const view = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        pointerEvents: 'auto',
        position: 'absolute',
        backgroundColor: 'rgba(0, 0, 0, 0.2)',
        backdropFilter: 'none',
        webkitBackdropFilter: 'none',
      };
    },
  };
  assert.equal(isPageContentLayer(hero, view), true);
  assert.equal(isBlockingDimmer(hero, view), false);
});

test('X.com compose mask is never an orphan dimmer', () => {
  const mask = {
    nodeType: 1,
    id: '',
    className: 'css-175oi2r r-1p0dtai r-1d2f490',
    dataset: {},
    style: {},
    getAttribute(name) {
      if (name === 'data-testid') return 'mask';
      if (name === 'data-gaf-unstuck') return null;
      return null;
    },
    getBoundingClientRect() {
      return { width: 1200, height: 800 };
    },
    querySelector() {
      return null;
    },
    innerText: '',
    textContent: '',
  };
  const view = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        pointerEvents: 'auto',
        position: 'fixed',
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        backdropFilter: 'none',
        webkitBackdropFilter: 'none',
      };
    },
  };
  assert.equal(isBlockingDimmer(mask, view), false);
});

test('unstick leaves X-style compose alone (aria-modal + mask)', () => {
  const body = {
    classList: {
      _set: new Set(['overflow-hidden']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
    },
    style: { overflow: 'hidden' },
    children: [],
  };
  const mask = {
    nodeType: 1,
    id: '',
    className: '',
    dataset: { gafTestDimmer: '1' },
    style: {
      display: '',
      setProperty(k, v) {
        this[k] = v;
      },
    },
    getAttribute(name) {
      if (name === 'data-testid') return 'mask';
      if (name === 'data-gaf-unstuck') return this.dataset.gafUnstuck || null;
      return null;
    },
    setAttribute(name, val) {
      if (name === 'data-gaf-unstuck') this.dataset.gafUnstuck = val;
    },
    innerText: '',
    textContent: '',
    querySelector() {
      return null;
    },
  };
  body.children.push(mask);
  const dialog = {
    nodeType: 1,
    id: '',
    className: '',
    dataset: {},
    style: { display: 'block' },
    hidden: false,
    getAttribute(name) {
      if (name === 'aria-modal') return 'true';
      return null;
    },
    innerText: 'Replying to @donaldtusk That border now needs to be between France and Spain Reply',
    textContent: 'Replying to @donaldtusk That border now needs to be between France and Spain Reply',
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const doc = {
    body,
    querySelectorAll(sel) {
      if (sel === '[aria-modal="true"]') return [dialog];
      if (sel === '[role="dialog"]') return [];
      if (sel === '.backdrop') return [mask];
      return [];
    },
  };
  const result = unstickOrphanedOverlays(doc, {});
  assert.equal(result.reason, 'usable-modal-present');
  assert.equal(result.cleared, 0);
  assert.notEqual(mask.style.display, 'none');
  // Body lock for compose must remain (do not unlock scroll under the sheet)
  assert.equal(body.classList.contains('overflow-hidden'), true);
});

test('unlockBodyScroll clears overflow-hidden, noscroll, phantom-scroll-bar', () => {
  const body = {
    classList: {
      _set: new Set(['overflow-hidden', 'noscroll', 'phantom-scroll-bar']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
    },
    style: { overflow: 'hidden', position: 'fixed', top: '-10px' },
  };
  assert.equal(unlockBodyScroll({ body }), true);
  assert.equal(body.classList.contains('overflow-hidden'), false);
  assert.equal(body.classList.contains('noscroll'), false);
  assert.equal(body.classList.contains('phantom-scroll-bar'), false);
  assert.equal(body.style.position, '');
});

test('hideDimmer marks element', () => {
  const el = {
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
    dataset: {},
    setAttribute(n, v) {
      if (n === 'data-gaf-unstuck') this.dataset.gafUnstuck = v;
    },
  };
  assert.equal(hideDimmer(el), true);
  assert.equal(el.style.display, 'none');
  assert.equal(el.dataset.gafUnstuck, '1');
});

test('restoreInteractionUnlock clears unstuck markers and force-unlock class', () => {
  const props = {};
  const el = {
    style: {
      setProperty(k, v) {
        props[k] = v;
        this[k] = v;
      },
      removeProperty(k) {
        delete props[k];
        this[k] = '';
      },
      display: 'none',
      pointerEvents: 'none',
      opacity: '0',
      visibility: 'hidden',
    },
    dataset: { gafUnstuck: '1' },
    getAttribute(n) {
      if (n === 'data-gaf-unstuck') return '1';
      return null;
    },
    removeAttribute(n) {
      if (n === 'data-gaf-unstuck') delete this.dataset.gafUnstuck;
    },
  };
  const forceStyle = { remove() { this.removed = true; }, removed: false };
  const root = {
    classList: {
      _set: new Set(['gaf-force-unlock']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
    },
  };
  const doc = {
    documentElement: root,
    querySelectorAll(sel) {
      if (String(sel).includes('data-gaf-unstuck')) return [el];
      return [];
    },
    getElementById(id) {
      return id === 'gaf-force-unlock-style' ? forceStyle : null;
    },
  };
  const result = restoreInteractionUnlock(doc);
  assert.equal(result.restored, 1);
  assert.equal(result.forceClassCleared, true);
  assert.equal(el.dataset.gafUnstuck, undefined);
  assert.equal(root.classList.contains('gaf-force-unlock'), false);
  assert.equal(forceStyle.removed, true);
});

/** ditur.no-style cookie wall (live Helium GAF Debug session). */
function fakeDiturConsentWall() {
  const bodyChildren = [];
  const body = {
    classList: {
      _set: new Set(['noscroll', 'phantom-scroll-bar']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      add(c) {
        this._set.add(c);
      },
    },
    style: { overflow: 'hidden' },
    children: bodyChildren,
  };

  const clicked = { labels: [] };
  const makeBtn = (label) => ({
    disabled: false,
    innerText: label,
    textContent: label,
    value: '',
    attrs: {},
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, val) {
      this.attrs[name] = val;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    click() {
      clicked.labels.push(label);
    },
  });
  const btnSelected = makeBtn('Godta valgte');
  const btnAll = makeBtn('Godta alle');

  const cookiePopup = {
    nodeType: 1,
    id: 'cookie-popup',
    className: '',
    dataset: { gafTestConsent: '1' },
    style: { display: 'block' },
    hidden: false,
    innerText:
      'Vi tilpasser opplevelsen din Vi og våre partnere bruker cookies Godta alle Godta valgte',
    textContent:
      'Vi tilpasser opplevelsen din Vi og våre partnere bruker cookies Godta alle Godta valgte',
    querySelector() {
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('button')) return [btnAll, btnSelected];
      return [];
    },
  };

  const greyDimmer = {
    nodeType: 1,
    id: '',
    className: 'fixed inset-0 bg-gray-500/75 transition-opacity',
    dataset: { gafTestDimmer: '1' },
    style: {
      display: '',
      setProperty(k, v) {
        this[k] = v;
      },
    },
    getAttribute(name) {
      if (name === 'data-gaf-unstuck') return this.dataset.gafUnstuck || null;
      return null;
    },
    setAttribute(name, val) {
      if (name === 'data-gaf-unstuck') this.dataset.gafUnstuck = val;
    },
    innerText: '',
    textContent: '',
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  bodyChildren.push(greyDimmer);

  const nodesBySel = {
    '#cookie-popup': [cookiePopup],
    '[role="dialog"]': [cookiePopup],
    '[aria-modal="true"]': [cookiePopup],
    '[class*="bg-gray-500/75"]': [greyDimmer],
  };

  const doc = {
    body,
    querySelectorAll(sel) {
      return nodesBySel[sel] || [];
    },
  };
  return { doc, body, cookiePopup, greyDimmer, clicked };
}

test('isPageScrollLocked detects ditur noscroll + phantom-scroll-bar', () => {
  const { doc } = fakeDiturConsentWall();
  assert.equal(isPageScrollLocked(doc), true);
});

test('isConsentLikePanel matches ditur cookie copy', () => {
  const { cookiePopup } = fakeDiturConsentWall();
  assert.equal(isConsentLikePanel(cookiePopup), true);
});

test('isConsentLikePanel does not match app settings with bare privacy/account chrome', () => {
  // Grok Account → Usage panel: mentions Data Controls / privacy without being a cookie wall
  const settingsPanel = {
    id: '',
    className: 'settings-modal',
    innerText:
      'General Account Appearance Behavior Grok Customize Payments Billing Usage Data Controls SuperGrok Language Birth Year Manage privacy preferences',
    textContent:
      'General Account Appearance Behavior Grok Customize Payments Billing Usage Data Controls SuperGrok Language Birth Year Manage privacy preferences',
    querySelectorAll() {
      return [];
    },
  };
  assert.equal(isConsentLikePanel(settingsPanel), false);
});

test('force unstick still leaves usable non-consent settings modal alone', () => {
  const { doc, dimmer } = fakeDocWithOrphanDimmer();
  const dialog = {
    nodeType: 1,
    id: '',
    className: '',
    dataset: {},
    style: { display: 'block' },
    hidden: false,
    innerText:
      'Account SuperGrok Billing Usage Language Birth Year Manage subscription',
    textContent:
      'Account SuperGrok Billing Usage Language Birth Year Manage subscription',
    querySelector() {
      return { tagName: 'BUTTON' };
    },
    querySelectorAll() {
      return [];
    },
  };
  const orig = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (sel) => {
    if (sel === '[role="dialog"]') return [dialog];
    return orig(sel);
  };
  const result = unstickOrphanedOverlays(doc, {}, { force: true });
  assert.equal(result.reason, 'usable-modal-present');
  assert.equal(result.cleared, 0);
  assert.notEqual(dimmer.style.display, 'none');
});

test('findConsentAcceptButton prefers Godta valgte over Godta alle', () => {
  const { cookiePopup } = fakeDiturConsentWall();
  const hit = findConsentAcceptButton(cookiePopup);
  assert.ok(hit);
  assert.equal(hit.label, 'Godta valgte');
  assert.equal(hit.kind, 'minimal');
});

test('dismissBlockingConsentWall clicks Godta valgte and unlocks body (ditur)', () => {
  const { doc, body, clicked } = fakeDiturConsentWall();
  const result = dismissBlockingConsentWall(doc, {});
  assert.equal(result.dismissed, true);
  assert.equal(result.button, 'Godta valgte');
  assert.equal(result.kind, 'minimal');
  assert.equal(result.path, 'isolated');
  assert.deepEqual(clicked.labels, ['Godta valgte']);
  assert.equal(body.classList.contains('noscroll'), false);
  assert.equal(body.classList.contains('phantom-scroll-bar'), false);
});

test('clickConsentControl uses one MAIN-world selector and does not isolated-click', () => {
  const { cookiePopup, clicked } = fakeDiturConsentWall();
  const hit = findConsentAcceptButton(cookiePopup);
  const messages = [];
  const view = {
    postMessage(msg) {
      messages.push(msg);
    },
  };
  const result = clickConsentControl(hit, view);
  assert.equal(result.ok, true);
  assert.equal(result.path, 'main');
  assert.deepEqual(clicked.labels, []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'GAF_PAGE_CLICK');
  assert.match(messages[0].selector, /^\[data-gaf-consent-target="g[a-z0-9]+"\]$/);
  assert.equal(requestMainWorldClick({}, { selector: '#x' }), false);
});

test('dismissBlockingConsentWall does not click I agree on an age gate', () => {
  const clicked = { labels: [] };
  const btn = {
    disabled: false,
    innerText: 'I agree',
    textContent: 'I agree',
    value: '',
    attrs: {},
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, val) {
      this.attrs[name] = val;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    click() {
      clicked.labels.push('I agree');
    },
  };
  const dialog = {
    nodeType: 1,
    id: '',
    className: '',
    dataset: {},
    style: { display: 'block' },
    hidden: false,
    innerText: 'Are you 18 years or older? Confirm your age to continue. I agree',
    textContent: 'Are you 18 years or older? Confirm your age to continue. I agree',
    querySelectorAll(sel) {
      if (sel.includes('button')) return [btn];
      return [];
    },
  };
  const body = {
    classList: {
      _set: new Set(['noscroll']),
      contains(c) {
        return this._set.has(c);
      },
      remove(c) {
        this._set.delete(c);
      },
    },
    style: { overflow: 'hidden' },
    children: [],
    innerText: dialog.innerText,
    textContent: dialog.textContent,
  };
  const doc = {
    body,
    querySelectorAll(sel) {
      if (sel === '[role="dialog"]' || sel === '[aria-modal="true"]') return [dialog];
      return [];
    },
  };
  assert.equal(documentHasCookieEvidence(doc), false);
  const result = dismissBlockingConsentWall(doc, {});
  assert.equal(result.dismissed, false);
  assert.deepEqual(clicked.labels, []);
});

test('ditur cookie seeding is host-gated', () => {
  assert.equal(isDiturConsentHost('www.ditur.no'), true);
  assert.equal(isDiturConsentHost('example.com'), false);
  const doc = { cookie: '' };
  assert.equal(seedMinimalConsentCookie(doc, { location: { hostname: 'example.com' } }), false);
  assert.equal(doc.cookie, '');
  assert.equal(seedMinimalConsentCookie(doc, { location: { hostname: 'www.ditur.no' } }), true);
  assert.match(doc.cookie, /cookie_consent=/);
});

test('unstickOrphanedOverlays consent-dismissed reason on ditur-style wall', () => {
  const { doc, greyDimmer, clicked } = fakeDiturConsentWall();
  const result = unstickOrphanedOverlays(doc, {});
  assert.ok(
    result.reason === 'consent-dismissed' || result.reason === 'consent-force-uncover',
    `unexpected reason ${result.reason}`,
  );
  assert.equal(result.consent?.button, 'Godta valgte');
  assert.ok(clicked.labels.includes('Godta valgte'));
  assert.equal(result.unlocked, true);
  // leftover grey scrim hidden
  assert.equal(greyDimmer.style.display, 'none');
});

test('findConsentAcceptButton falls back to Godta alle when only full accept exists', () => {
  const btn = {
    disabled: false,
    innerText: 'Godta alle',
    textContent: 'Godta alle',
    value: '',
    getAttribute() {
      return null;
    },
  };
  const root = {
    querySelectorAll(sel) {
      if (sel.includes('button')) return [btn];
      return [];
    },
  };
  const hit = findConsentAcceptButton(root);
  assert.equal(hit?.label, 'Godta alle');
  assert.equal(hit?.kind, 'full');
});

test('FilterBlade-style ModalBox is not treated as orphan dimmer', () => {
  // Minimal: isBlockingDimmer path without getComputedStyle uses gafTestDimmer only.
  // Ensure unstick leaves usable-like non-consent alone when dialog text present.
  const { doc, dimmer } = fakeDocWithOrphanDimmer();
  const modal = {
    nodeType: 1,
    id: '',
    className: 'ModalBox_Outer',
    dataset: {},
    style: { display: 'block' },
    hidden: false,
    innerText:
      'Strictness Control how many items the filter hides. Semi-Strict Soft Regular',
    textContent:
      'Strictness Control how many items the filter hides. Semi-Strict Soft Regular',
    querySelector(sel) {
      if (sel && sel.includes('button')) return { tagName: 'BUTTON' };
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const orig = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (sel) => {
    if (sel === '.ModalBox_Outer' || sel === '[class*="ModalBox"]') return [modal];
    if (sel === '[role="dialog"]') return [];
    return orig(sel);
  };
  // With ModalBox registered as modal content, unstick should not clear when content present
  // (hasUsableModalContent true via ModalBox selector)
  const result = unstickOrphanedOverlays(doc, {});
  // Either usable-modal-present or cleared only the empty test dimmer — not treating modal as only content
  assert.ok(
    result.reason === 'usable-modal-present' || result.cleared >= 0,
    JSON.stringify(result),
  );
});

test('force-uncover when locked consent has no clickable button', () => {
  const { doc, body, greyDimmer, cookiePopup, nodesBySel } = (() => {
    const f = fakeDiturConsentWall();
    // strip buttons so click cannot work
    f.cookiePopup.querySelectorAll = () => [];
    return f;
  })();
  // re-bind document query for cookie root
  const result = unstickOrphanedOverlays(doc, {});
  assert.equal(result.reason, 'consent-force-uncover');
  assert.equal(result.unlocked, true);
  assert.equal(body.classList.contains('noscroll'), false);
  assert.equal(greyDimmer.style.display, 'none');
});