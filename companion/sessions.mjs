import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright';

export const secret = () => randomBytes(32).toString('hex');
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
/**
 * Cloud instance-metadata services hand out the host's credentials over plain
 * HTTP. A website could get an agent with interaction access to click a link
 * there and then read the page, so the remote browser never loads them: typed
 * addresses are refused (pageUrl) and Chromium's resolver refuses the hosts
 * for links, redirects, frames and subresources (METADATA_RESOLVER_RULES).
 * A hostname that merely resolves to one of these addresses is not caught;
 * on a cloud host also require IMDSv2 / block metadata at the network.
 */
export const METADATA_RESOLVER_RULES = [
  '169.254.*', '100.100.100.200', 'fd00:ec2::254', '[fd00:ec2::254]',
  'metadata.google.internal', '*.metadata.google.internal', 'metadata.goog',
].map(host => `MAP ${host} ~NOTFOUND`).join(', ');

export function isMetadataHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(h) || // link-local: AWS, Azure, GCP, Oracle, DO, ECS
    h === '100.100.100.200' || // Alibaba Cloud
    h === 'fd00:ec2::254' || // AWS IPv6
    h === 'metadata.google.internal' || h === 'metadata.goog' || h.endsWith('.metadata.google.internal');
}

export function pageUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP/HTTPS page addresses are supported.');
  if (isMetadataHost(url.hostname)) throw new Error('Cloud metadata addresses are blocked.');
  return url.href;
}

export class Sessions {
  constructor({ launch = options => chromium.launch(options), now = Date.now, leaseMs = 90_000, maxLifetimeMs = 3_600_000, maxSessions = 3, executablePath } = {}) {
    Object.assign(this, { launch, now, leaseMs, maxLifetimeMs, maxSessions, executablePath });
    this.items = new Map();
    this.pending = 0;
    this.timer = setInterval(() => this.sweep().catch(() => {}), 1000);
    this.timer.unref();
  }
  async create({ url, idleMinutes = 15, agents = [] }) {
    url = pageUrl(url);
    if (this.items.size + this.pending >= this.maxSessions) throw new Error('All remote sessions are busy. End another session first.');
    this.pending++;
    let browser;
    let session;
    try {
      // Each session owns its browser process and a fresh non-persistent context.
      browser = await this.launch({ headless: true, executablePath: this.executablePath, args: [`--host-resolver-rules=${METADATA_RESOLVER_RULES}`] });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
      context.setDefaultTimeout(3000);
      session = {
        id: randomBytes(16).toString('hex'), ownerToken: secret(), browser, context,
        createdAt: this.now(), lastActivity: this.now(), lastOwner: this.now(),
        idleMs: Math.max(1, Math.min(60, Number(idleMinutes) || 15)) * 60_000,
        agents: [...new Set((Array.isArray(agents) ? agents : []).map(a => String(a).trim().slice(0, 80)).filter(Boolean))].slice(0, 12),
        pages: new Map(), active: '', root: null, grant: null, epoch: 0, accessRevision: 0,
        refs: new Map(), tail: Promise.resolve(), closed: false,
      };
      this.items.set(session.id, session);
      context.on('page', page => this.addPage(session, page));
      const root = await context.newPage();
      session.root = root;
      root.on('close', () => { void this.end(session); });
      browser.on('disconnected', () => { void this.end(session); });
      // Return the viewer promptly, including when a site responds slowly or refuses navigation.
      void root.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      return session;
    } catch (error) {
      if (session) await this.end(session);
      else if (browser) await browser.close();
      throw error;
    } finally { this.pending--; }
  }
  addPage(session, page) {
    if (session.closed) { void page.close(); return; }
    const id = randomBytes(8).toString('hex');
    session.pages.set(id, page);
    session.active = id;
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    page.on('download', download => { void download.cancel().catch(() => {}); });
    page.on('close', () => {
      session.pages.delete(id);
      this.clearRefs(session);
      if (session.active === id) session.active = session.pages.keys().next().value || '';
    });
    page.on('framenavigated', () => this.clearRefs(session));
  }
  /** Forget control references and release their browser-side element handles. */
  clearRefs(s) {
    for (const { element } of s.refs.values()) void element.dispose().catch(() => {});
    s.refs.clear();
  }
  expired(s) {
    return s.closed || this.now() - s.lastOwner >= this.leaseMs ||
      this.now() - s.lastActivity >= s.idleMs || this.now() - s.createdAt >= this.maxLifetimeMs;
  }
  owner(id, token) {
    const s = this.items.get(id);
    if (!s || this.expired(s) || !sameSecret(s.ownerToken, token)) throw new Error('Session ended or access denied.');
    return s;
  }
  agent(token) {
    const s = [...this.items.values()].find(s => s.grant && sameSecret(s.grant.token, token));
    if (!s || this.expired(s)) throw new Error('Agent access is off or the session has ended.');
    return s;
  }
  requireAgent(s, token, interact = false) {
    if (this.expired(s) || !s.grant || !sameSecret(s.grant.token, token) || (interact && s.grant.access !== 'interact')) {
      throw new Error('Permission revoked or interaction is not allowed.');
    }
  }
  page(s) {
    const page = s.pages.get(s.active);
    if (!page || page.isClosed()) throw new Error('No page is open.');
    return page;
  }
  async state(s) {
    return {
      id: s.id, active: s.active, access: s.grant?.access || 'off', agent: s.grant?.name || '', agents: s.agents, accessRevision: s.accessRevision,
      idleSecondsLeft: Math.max(0, Math.ceil((s.idleMs - (this.now() - s.lastActivity)) / 1000)),
      pages: await Promise.all([...s.pages].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title().catch(() => '') }))),
    };
  }
  grant(s, { agent, access, revision }) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision <= s.accessRevision)) throw new Error('A newer access choice has already been applied.');
    if (!['off', 'read', 'interact'].includes(access)) throw new Error('Unknown access level.');
    if (access !== 'off' && !s.agents.includes(agent)) throw new Error('Choose a configured agent.');
    // Synchronous revocation prevents queued actions from running after Take over.
    s.epoch++;
    s.accessRevision = revision ?? s.accessRevision + 1;
    this.clearRefs(s);
    s.grant = access === 'off' ? null : { name: agent, access, token: secret() };
    s.lastActivity = this.now();
    return { access, agentToken: s.grant?.token || null };
  }
  async queued(s, check, operation) {
    const epoch = s.epoch;
    const work = s.tail.catch(() => {}).then(async () => {
      check();
      if (s.closed || epoch !== s.epoch) throw new Error('The session or permission changed.');
      return operation();
    });
    s.tail = work;
    return work;
  }
  async input(s, action, check = () => { if (this.expired(s)) throw new Error('Session ended.'); }) {
    return this.queued(s, check, async () => {
      const page = this.page(s);
      s.lastActivity = this.now();
      switch (action.type) {
        case 'click': {
          if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.y < 0 || action.x > 1280 || action.y > 800) throw new Error('Click is outside the page.');
          await page.mouse.click(action.x, action.y); break;
        }
        case 'key': {
          if (typeof action.key !== 'string' || action.key.length > 60) throw new Error('Invalid key.');
          await page.keyboard.press(action.key); break;
        }
        case 'text': {
          if (typeof action.text !== 'string' || action.text.length > 10_000) throw new Error('Text is too long.');
          await page.keyboard.insertText(action.text); break;
        }
        case 'scroll': {
          if (!Number.isFinite(action.dy)) throw new Error('Invalid scroll.');
          await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, action.dy))); break;
        }
        case 'navigate': await page.goto(pageUrl(action.url), { waitUntil: 'domcontentloaded', timeout: 10_000 }); break;
        case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }); break;
        case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 }); break;
        case 'selectPage': {
          if (!s.pages.has(action.id)) throw new Error('Window closed.');
          s.active = action.id; this.clearRefs(s); break;
        }
        case 'closePopup': {
          if (page === s.root) throw new Error('Use End session to close the main page.');
          await page.close(); break;
        }
        default: throw new Error('Unknown action.');
      }
    });
  }
  async read(s, token) {
    return this.queued(s, () => this.requireAgent(s, token), async () => {
      this.clearRefs(s);
      const page = this.page(s);
      const prefix = randomBytes(4).toString('hex');
      const controls = [];
      for (const frame of page.frames()) {
        const elements = await frame.locator('a[href], button, input:not([type=hidden]), textarea, select, [role=button]').elementHandles();
        // Every handle not kept as a reference is released at once; kept ones on the next clear.
        for (const extra of elements.slice(200)) void extra.dispose().catch(() => {});
        for (const element of elements.slice(0, 200)) {
          if (!(await element.isVisible().catch(() => false))) { void element.dispose().catch(() => {}); continue; }
          const info = await element.evaluate(el => ({
            tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '',
            label: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || '').slice(0, 200),
          })).catch(() => null);
          if (!info) { void element.dispose().catch(() => {}); continue; }
          const ref = `${prefix}-${controls.length}`;
          s.refs.set(ref, { element, page });
          controls.push({ ref, ...info });
        }
      }
      return { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 30_000), controls };
    });
  }
  async act(s, token, action) {
    return this.queued(s, () => this.requireAgent(s, token, true), async () => {
      const found = s.refs.get(action.ref);
      if (!found || found.page !== this.page(s)) throw new Error('Read the page again to get a current control reference.');
      if (action.type === 'click') await found.element.click({ timeout: 2000 });
      else if (action.type === 'fill') {
        if (typeof action.text !== 'string' || action.text.length > 10_000) throw new Error('Invalid text.');
        const sensitive = await found.element.evaluate(el => el.type === 'password' || /password|one-time-code|cc-|webauthn/.test(el.autocomplete || ''));
        if (sensitive) throw new Error('The user enters credentials and authentication codes manually.');
        await found.element.fill(action.text, { timeout: 2000 });
      } else throw new Error('Unknown action.');
      this.clearRefs(s);
      s.lastActivity = this.now();
      return { done: true };
    });
  }
  async end(s) {
    if (s.closed) return;
    s.closed = true; s.epoch++; s.grant = null; s.refs.clear(); // the context close below releases handles
    this.items.delete(s.id);
    try { await s.context.close(); } finally {
      await s.browser.close();
      s.pages.clear(); s.ownerToken = ''; s.agents = [];
    }
  }
  async sweep() { await Promise.all([...this.items.values()].filter(s => this.expired(s)).map(s => this.end(s))); }
  async close() { clearInterval(this.timer); await Promise.all([...this.items.values()].map(s => this.end(s))); }
}
