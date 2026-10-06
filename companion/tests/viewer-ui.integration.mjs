// Shared-session viewer and popup UI (issue #22), against the real extension in
// Chromium and a small stand-in companion (no MCP or remote browser needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION_ID = 'a'.repeat(32);
const WAITING = 'Waiting for the remote page…';

/** Stand-in companion: the HTTP surface the viewer uses, with scriptable state. */
function standInCompanion(jpeg) {
  const log = { created: [], grants: [], inputs: [], frames: 0 };
  const state = {
    framesToFail: 2, idleSecondsLeft: 900, access: 'off', agent: '', accessRevision: 0,
    pages: [{ id: 'p1', url: 'https://example.test/', title: 'Short' }], active: 'p1',
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/sessions' && req.method === 'POST') {
      log.created.push({ token, body: json });
      return send(201, { id: SESSION_ID, ownerToken: 'owner-token' });
    }
    if (path === `/sessions/${SESSION_ID}` && req.method === 'DELETE') return send(204);
    const action = path.slice(`/sessions/${SESSION_ID}/`.length);
    if (action === 'state') return send(200, { id: SESSION_ID, agents: ['Helper', 'Second'], ...state });
    if (action === 'heartbeat') return send(204);
    if (action === 'input') { log.inputs.push(json); return send(204); }
    if (action === 'grant') {
      log.grants.push(json);
      state.access = json.access; state.agent = json.access === 'off' ? '' : json.agent;
      state.accessRevision = json.revision ?? state.accessRevision + 1;
      return send(200, { access: json.access, agentToken: json.access === 'off' ? null : 'agent-token' });
    }
    if (action === 'frame') {
      log.frames++;
      if (state.framesToFail > 0) { state.framesToFail--; return send(503, { error: 'not yet' }); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(jpeg);
    }
    return send(404, { error: 'Not found.' });
  });
  return { server, state, log };
}

let browser, profile, companion, fixture, worker, base, sourceUrl;
before(async () => {
  profile = await mkdtemp(resolve(tmpdir(), 'gaf-viewer-ui-'));
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  base = `chrome-extension://${new URL(worker.url()).host}`;
  // A real JPEG for the remote picture.
  const shot = await browser.newPage();
  await shot.setContent('<body style="margin:0;background:#2b6">remote</body>');
  const jpeg = await shot.screenshot({ type: 'jpeg', clip: { x: 0, y: 0, width: 128, height: 80 } });
  await shot.close();
  companion = standInCompanion(jpeg);
  await new Promise(r => companion.server.listen(0, '127.0.0.1', r));
  fixture = http.createServer((req, res) => res.end('<!doctype html><title>Source</title><h1>Source page</h1>'));
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  sourceUrl = `http://127.0.0.1:${fixture.address().port}/`;
  const endpoint = `http://127.0.0.1:${companion.server.address().port}`;
  await worker.evaluate(async endpoint => chrome.storage.local.set({ gafRemoteConnections: {
    providers: [
      { id: 'one', name: 'Route one', endpoint, token: 'token-one' },
      { id: 'two', name: 'Route two', endpoint, token: 'token-two' },
    ],
    defaultProvider: 'one', idleMinutes: 15, agents: ['Helper', 'Second'],
  } }), endpoint);
});
after(async () => {
  await browser?.close();
  await new Promise(r => companion?.server.close(r));
  await new Promise(r => fixture?.close(r));
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('popup connection choice, viewer layout, status and access controls (issue #22)', async () => {
  const source = await browser.newPage();
  await source.goto(sourceUrl);
  // Real popup code in an extension tab (the toolbar popup is not automatable).
  const popup = await browser.newPage();
  await popup.goto(`${base}/src/popup/popup.html`);
  assert.equal(await popup.locator('select#remoteRoute').count(), 0, 'no native <select> for the connection');
  assert.equal(await popup.getByRole('radio', { name: 'Route one' }).isChecked(), true, 'default connection preselected');
  await popup.getByRole('radio', { name: 'Route two' }).check();
  await source.bringToFront();
  await popup.evaluate(() => document.querySelector('#reloadRemote').click());
  await source.waitForURL(`${base}/src/remote/viewer.html`);
  assert.equal(companion.log.created[0].token, 'token-two', 'one click on a choice picks the connection');

  // 1. "Waiting…" appears while frames fail, and clears once one is painted.
  for (let i = 0; i < 100 && companion.log.frames < 3; i++) await source.waitForTimeout(100);
  assert.ok(companion.log.frames >= 3, 'two failed frames, then a painted one');
  await source.waitForFunction(w => document.querySelector('#status').textContent !== w, WAITING, { timeout: 5_000 });
  assert.notEqual(await source.locator('#status').textContent(), WAITING);

  // 2. Everything fits one window: no page scroll, picture inside, 1280×800 proportions.
  const geometry = () => source.evaluate(() => {
    const r = sel => { const b = document.querySelector(sel).getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(v => Math.round(v * 10) / 10); };
    return {
      scroll: [scrollX, scrollY, document.scrollingElement.scrollHeight - innerHeight, document.scrollingElement.scrollWidth - innerWidth],
      header: r('header'), access: r('#accessGroup'), agents: r('#agents'), canvas: r('#screen'), status: r('#status'),
    };
  });
  const start = await geometry();
  assert.deepEqual(start.scroll, [0, 0, 0, 0], 'viewer page does not scroll');
  const [, cy, cw, ch] = start.canvas;
  assert.ok(cy + ch <= 800 + 0.5, 'picture fits the window');
  assert.ok(Math.abs(cw / ch - 1.6) < 0.01, `picture keeps its proportions (${cw}×${ch})`);

  // 3. Nothing moves, and unchanged text is not rewritten, while the session runs.
  await source.evaluate(() => {
    window.__writes = 0;
    new MutationObserver(list => { window.__writes += list.length; }).observe(document.querySelector('header').parentElement, { subtree: true, childList: true, characterData: true });
  });
  await source.waitForTimeout(5600); // two state polls, many frames, no remote changes
  assert.equal(await source.evaluate(() => window.__writes), 0, 'idle polling leaves the DOM alone');
  companion.state.pages = [
    { id: 'p1', url: 'https://example.test/a/very/long/path', title: 'A remote page with a really very long title that would have widened the window list a lot' },
    { id: 'p2', url: 'https://login.example.test/', title: 'Sign-in pop-up window' },
  ];
  companion.state.idleSecondsLeft = 61;
  await source.waitForTimeout(5600);
  const later = await geometry();
  for (const part of ['header', 'access', 'agents', 'canvas', 'status']) assert.deepEqual(later[part], start[part], `${part} did not move`);
  assert.equal(await source.locator('#closePopup').isDisabled(), false, 'state still updates');

  // 4. Clicking the picture keeps the toolbars in place and maps to remote pixels.
  await source.locator('#screen').click({ position: { x: cw / 2, y: ch / 2 } });
  assert.deepEqual((await geometry()).scroll, [0, 0, 0, 0], 'focusing the picture does not scroll');
  await source.waitForFunction(() => true);
  for (let i = 0; i < 40 && !companion.log.inputs.some(a => a.type === 'click'); i++) await source.waitForTimeout(50);
  const click = companion.log.inputs.find(a => a.type === 'click');
  assert.ok(Math.abs(click.x - 640) < 2 && Math.abs(click.y - 400) < 2, `click maps to the remote centre (${click.x}, ${click.y})`);

  // 5. Agent and Access are one-click choices.
  assert.equal(await source.locator('select#access, select#agent').count(), 0, 'no native <select> for agent/access');
  await source.getByRole('radio', { name: 'Second' }).check();
  await source.getByRole('radio', { name: 'Read only' }).check();
  await source.getByRole('button', { name: 'Apply access' }).click();
  await source.locator('#invitation').waitFor({ state: 'visible' });
  const grant = companion.log.grants.at(-1);
  assert.equal(grant.access, 'read'); assert.equal(grant.agent, 'Second');
  await source.getByRole('button', { name: 'Take over · revoke access' }).click();
  await source.locator('#invitation').waitFor({ state: 'hidden' });
  assert.equal(await source.locator('input[name="access"]:checked').inputValue(), 'off');
});
