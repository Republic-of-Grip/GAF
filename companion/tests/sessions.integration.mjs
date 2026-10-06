import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Sessions, secret } from '../sessions.mjs';
import { createCompanion } from '../server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let fixture, url;
before(async () => {
  fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Session fixture</title><h1>Shared page</h1><label>Message<input id="message"></label><label>Password<input id="password" type="password"></label><button id="change" onclick="document.querySelector(\'h1\').textContent=\'Changed\'">Change heading</button><a href="/popup" target="_blank">Authentication pop-up</a>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${fixture.address().port}/`;
});
after(() => new Promise(resolve => fixture.close(resolve)));
async function opened(manager, options = {}) {
  const s = await manager.create({ url, agents: ['Assistant'], ...options });
  await s.root.waitForSelector('h1'); return s;
}

test('fresh processes isolate cookies, page storage, passwords and pop-ups; teardown closes all', async t => {
  const manager = new Sessions(); t.after(() => manager.close());
  const first = await opened(manager);
  await first.context.addCookies([{ name: 'auth', value: 'private', url }]);
  await first.root.evaluate(() => { localStorage.setItem('private', 'secret'); });
  await first.root.locator('#password').fill('manual-password');
  const popupPromise = first.context.waitForEvent('page');
  await first.root.locator('a').click();
  const popup = await popupPromise; await popup.waitForLoadState();
  assert.equal(first.pages.size, 2);
  const second = await opened(manager);
  assert.deepEqual(await second.context.cookies(), []);
  assert.equal(await second.root.evaluate(() => localStorage.getItem('private')), null);
  assert.equal(await second.root.locator('#password').inputValue(), '');
  const owner = first.ownerToken;
  await manager.end(first);
  assert.equal(popup.isClosed(), true); assert.equal(first.root.isClosed(), true);
  assert.equal(first.browser.isConnected(), false); assert.equal(first.pages.size, 0);
  assert.throws(() => manager.owner(first.id, owner));
  assert.equal(second.root.isClosed(), false);
});

test('agent grants are session-bound, read-only cannot act, takeover invalidates tokens and queued work', async t => {
  const manager = new Sessions(); t.after(() => manager.close()); const s = await opened(manager);
  assert.equal(s.grant, null); assert.throws(() => manager.agent(secret()));
  const readToken = manager.grant(s, { agent: 'Assistant', access: 'read' }).agentToken;
  const read = await manager.read(s, readToken);
  assert.equal(JSON.stringify(read).includes('manual-password'), false);
  const button = read.controls.find(c => c.label === 'Change heading');
  await assert.rejects(manager.act(s, readToken, { type: 'click', ref: button.ref }), /not allowed/);
  const token = manager.grant(s, { agent: 'Assistant', access: 'interact' }).agentToken;
  assert.throws(() => manager.agent(readToken));
  const fresh = await manager.read(s, token);
  const input = fresh.controls.find(c => c.label === 'Message');
  await manager.act(s, token, { type: 'fill', ref: input.ref, text: 'From agent' });
  assert.equal(await s.root.locator('#message').inputValue(), 'From agent');
  const next = await manager.read(s, token);
  const password = next.controls.find(c => c.type === 'password');
  await assert.rejects(manager.act(s, token, { type: 'fill', ref: password.ref, text: 'not allowed' }), /manually/);
  let release; s.tail = new Promise(resolve => { release = resolve; });
  const queued = manager.act(s, token, { type: 'click', ref: next.controls.find(c => c.label === 'Change heading').ref });
  manager.grant(s, { access: 'off' }); release();
  await assert.rejects(queued, /revoked/);
  assert.equal(await s.root.locator('h1').innerText(), 'Shared page');
  assert.throws(() => manager.agent(token));
  const revision = s.accessRevision;
  manager.grant(s, { access: 'off', revision: revision + 2 });
  assert.throws(() => manager.grant(s, { agent: 'Assistant', access: 'interact', revision: revision + 1 }), /newer access/);
  assert.equal(s.grant, null); // An older in-flight grant cannot undo a newer takeover.
});

test('idle timeout and lost-owner lease clear sessions even when an agent is connected', async t => {
  let clock = 0; const manager = new Sessions({ now: () => clock, leaseMs: 90_000 }); t.after(() => manager.close());
  const idle = await opened(manager, { idleMinutes: 1 });
  const token = manager.grant(idle, { agent: 'Assistant', access: 'interact' }).agentToken;
  clock = 60_001; idle.lastOwner = clock;
  await manager.sweep(); assert.equal(idle.browser.isConnected(), false); assert.throws(() => manager.agent(token));
  const orphan = await opened(manager);
  clock += 90_001; orphan.lastActivity = clock; // Agent activity cannot keep a disconnected owner's session alive.
  await manager.sweep(); assert.equal(orphan.browser.isConnected(), false);
});

test('closing the remote main page closes its related pop-ups and process', async t => {
  const manager = new Sessions(); t.after(() => manager.close()); const s = await opened(manager);
  await s.context.newPage(); await s.root.close();
  for (let i = 0; i < 30 && s.browser.isConnected(); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(manager.items.size, 0); assert.equal(s.browser.isConnected(), false);
});

test('HTTP and actual MCP client enforce bearer credentials, origin checks and access changes', async t => {
  const apiToken = secret(); const app = createCompanion({ apiToken });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })).status, 401);
  assert.equal((await fetch(`${base}/sessions`, { method: 'POST', headers: { ...headers, Origin: 'https://hostile.example' }, body: JSON.stringify({ url }) })).status, 403);
  const created = await fetch(`${base}/sessions`, { method: 'POST', headers, body: JSON.stringify({ url, agents: ['Assistant'] }) });
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { id, ownerToken } = await created.json(); const s = app.sessions.owner(id, ownerToken); await s.root.waitForSelector('h1');
  assert.equal((await fetch(`${base}/sessions/${id}/state`, { headers })).status, 410);
  const ownerHeaders = { ...headers, Authorization: `Bearer ${ownerToken}` };
  assert.equal((await fetch(`${base}/sessions/${id}/frame`, { headers: ownerHeaders })).headers.get('content-type'), 'image/jpeg');
  const grantResponse = await fetch(`${base}/sessions/${id}/grant`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ agent: 'Assistant', access: 'read' }) });
  const { agentToken } = await grantResponse.json();
  const client = new Client({ name: 'integration-test', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agentToken}` } } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['gaf_page_read']);
  const result = await client.callTool({ name: 'gaf_page_read', arguments: {} });
  assert.match(result.content[0].text, /Shared page/);
  const denied = await client.callTool({ name: 'gaf_page_click', arguments: { ref: 'bogus' } });
  assert.equal(denied.isError, true);
  await fetch(`${base}/sessions/${id}/grant`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ access: 'off' }) });
  await assert.rejects(client.listTools());
  assert.equal((await fetch(`${base}/sessions/${id}`, { method: 'DELETE', headers: ownerHeaders })).status, 204);
  assert.equal(s.browser.isConnected(), false);
});
