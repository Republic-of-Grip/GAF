// Real extension flow using only isolated Chromium profiles and synthetic fixture data.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createCompanion } from '../server.mjs';
import { secret } from '../sessions.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inspect = process.argv.includes('--inspect');
// Optional artefacts go only where asked (never beside the repository): --screenshot=<file>.
const screenshotPath = process.argv.find(a => a.startsWith('--screenshot='))?.slice('--screenshot='.length) || '';
const profile = await mkdtemp(resolve(tmpdir(), 'gaf-extension-test-'));
const key = secret();
const app = createCompanion({ apiToken: key });
const fixture = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Shared-session test</title><style>body{font:24px system-ui;padding:32px;background:#f6f9fc}input,button{font:inherit;margin:12px;padding:12px}</style><h1>Shared-session test page</h1><label>Message<input id="message"></label><label>Password<input id="password" type="password"></label><button id="change" onclick="document.querySelector(\'h1\').textContent=\'Agent updated this page\'">Change heading</button><a href="/auth" target="_blank">Open authentication window</a>');
});
let browser;
let client;
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const sourceUrl = `http://127.0.0.1:${fixture.address().port}/`;
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 1080 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, ...(inspect ? ['--remote-debugging-port=9337'] : [])],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const base = `chrome-extension://${extensionId}`;
  const errors = [];
  const options = await browser.newPage();
  options.on('pageerror', error => errors.push(error.message));
  await options.goto(`${base}/src/options/options.html`);
  await options.getByRole('button', { name: 'Shared sessions', exact: true }).click();
  await options.getByRole('button', { name: 'Add connection' }).click();
  await options.getByLabel('Connection name', { exact: true }).fill('Local test route');
  await options.getByLabel('Server address', { exact: true }).fill(endpoint);
  await options.getByLabel('Connection key', { exact: true }).fill(key);
  await options.getByLabel('Agent names, one per line').fill('Test assistant');
  await options.getByRole('button', { name: 'Save shared-session settings', exact: true }).click();
  await options.getByText('Saved locally. New sessions use these settings; existing sessions keep their connection.').waitFor();
  const source = await browser.newPage();
  source.on('pageerror', error => errors.push(error.message));
  await source.goto(sourceUrl);
  const sourceId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  // Headless Chromium does not expose action.openPopup() as a Playwright page.
  // Render the real popup code in an inactive extension tab, keeping the source
  // selected, exactly as chrome.tabs.query sees it in the toolbar popup.
  const popup = await browser.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`${base}/src/popup/popup.html`);
  await popup.getByRole('button', { name: 'Reload this URL remotely' }).waitFor();
  await source.bringToFront();
  await popup.evaluate(() => document.querySelector('#reloadRemote').click());
  await source.waitForURL(`${base}/src/remote/viewer.html`);
  await source.getByText('You have control. Agent access revoked', { exact: false }).waitFor();
  const session = [...app.sessions.items.values()][0];
  assert.equal(app.sessions.items.size, 1);
  assert.equal(session.grant, null);
  await session.root.waitForSelector('#message');
  // Viewer pointer mapping, typed/pasted text, and password entry traverse the HTTP companion.
  const field = await session.root.locator('#message').boundingBox();
  await source.locator('#screen').click({ position: { x: field.x + 15, y: field.y + 15 } });
  await source.locator('#screen').pressSequentially('Hello from GAF');
  await source.waitForFunction(() => document.querySelector('#screen').toDataURL().length > 10_000);
  for (let i = 0; i < 100 && await session.root.locator('#message').inputValue() !== 'Hello from GAF'; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(await session.root.locator('#message').inputValue(), 'Hello from GAF');
  const popupReady = session.context.waitForEvent('page');
  await session.root.locator('a').click();
  const auth = await popupReady; await auth.waitForLoadState();
  await source.waitForFunction(() => document.querySelector('#pages').options.length === 2);
  await source.selectOption('#pages', [...session.pages].find(([, page]) => page === session.root)[0]);
  await source.selectOption('#access', 'interact');
  await source.getByRole('button', { name: 'Apply access' }).click();
  await source.locator('#invitation').waitFor({ state: 'visible' });
  const token = await source.locator('#agentToken').inputValue();
  client = new Client({ name: 'viewer-flow-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const read = await client.callTool({ name: 'gaf_page_read', arguments: {} });
  const contents = JSON.parse(read.content[0].text);
  const ref = contents.controls.find(c => c.label === 'Change heading').ref;
  const changed = await client.callTool({ name: 'gaf_page_click', arguments: { ref } });
  assert.equal(changed.isError, undefined);
  assert.equal(await session.root.locator('h1').innerText(), 'Agent updated this page');
  await source.getByRole('button', { name: 'Take over · revoke access' }).click();
  await source.locator('#invitation').waitFor({ state: 'hidden' });
  await source.getByText('You have control. Agent access revoked', { exact: false }).waitFor();
  assert.equal(await source.locator('#access').inputValue(), 'off');
  assert.equal(await source.locator('#permission').innerText(), 'Agent access off');
  await assert.rejects(client.listTools());
  assert.equal(session.grant, null);
  if (screenshotPath) {
    await source.waitForTimeout(500); // Capture a subsequent remote frame for visual QA.
    await source.screenshot({ path: resolve(screenshotPath) });
  }
  assert.deepEqual(errors, []);
  if (inspect) {
    const inspection = resolve(tmpdir(), 'gaf-browser-inspection.json');
    await writeFile(inspection, JSON.stringify({ extensionId, sourceId, viewerUrl: `${base}/src/remote/viewer.html`, optionsUrl: `${base}/src/options/options.html` }));
    console.log(`Browser verification ready on port 9337 (${inspection}). No session credentials printed.`);
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 60_000);
      process.once('SIGUSR1', () => { clearTimeout(timeout); resolve(); });
    });
  }
  // Closing the real local viewer must delete the remote context, not merely hide it.
  await source.close();
  for (let i = 0; i < 100 && app.sessions.items.size; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(app.sessions.items.size, 0);
  for (let i = 0; i < 100 && session.browser.isConnected(); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(session.browser.isConnected(), false);
  assert.equal(auth.isClosed(), true);
  // The worker removes its record only after the companion answers the DELETE,
  // which can land after the browser above disconnects: wait for it, don't race it.
  const hasRecord = () => worker.evaluate(async () =>
    Object.keys(await chrome.storage.session.get(null)).some(k => k.startsWith('gafRemoteTab:')));
  for (let i = 0; i < 200 && await hasRecord(); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(await hasRecord(), false);
  console.log('PASS: settings → GAF popup code (inactive-tab harness) → remote viewer → pointer/keyboard → auth popup → actual MCP agent → takeover → local tab close and cleanup. No page errors.');
} finally {
  await client?.close().catch(() => {});
  await browser?.close();
  await app.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
