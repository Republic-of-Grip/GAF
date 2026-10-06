import { remoteRequest, connectionVerdict } from '../core/remote-session.mjs';

const $ = id => document.getElementById(id);
let session;
let stopped = false;
let inputTail = Promise.resolve();
let accessRevision = 0;
const timers = [];
let lastHeartbeatOk = Date.now();
let interrupted = false;
/**
 * A failed poll is not the end of the session: Wi-Fi blips and a busy
 * companion are normal. End only when the server says the session is gone
 * (410) or no heartbeat has landed for a whole lease.
 */
function connectionProblem(error) {
  if (stopped) return;
  const verdict = connectionVerdict(error, Date.now() - lastHeartbeatOk);
  if (verdict === 'ended') return finish('Session ended. Close this tab and start a fresh session from GAF.');
  if (verdict === 'expired') return finish('Connection lost. The remote session has expired; start a fresh one from GAF.');
  interrupted = true;
  status('Connection interrupted — retrying…');
}
function connectionOk() {
  if (!interrupted || stopped) return;
  interrupted = false;
  status('Connection restored.');
}
async function heartbeat() {
  if (stopped) return;
  await request('heartbeat', { method: 'POST' });
  lastHeartbeatOk = Date.now();
  connectionOk();
}
const screen = $('screen');
const drawing = screen.getContext('2d');
/**
 * Write only when the value changes. Rewriting identical text every poll still
 * re-lays out the toolbar row, and Chromium then collapses or misplaces an
 * open control in that row (issue #22).
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
const status = text => setText($('status'), text);
const WAITING = 'Waiting for the remote page…';
const radioValue = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
  if (input && !input.checked) input.checked = true;
}
const request = (action, options) => remoteRequest(session.endpoint, `/sessions/${session.id}/${action}`, session.ownerToken, options);

function clearInvitation() {
  $('agentToken').value = ''; $('agentToken').type = 'password'; $('revealToken').textContent = 'Show token';
  $('mcpUrl').value = ''; $('invitation').hidden = true;
}
function finish(message) {
  if (stopped) return;
  stopped = true;
  // Drop extension-session metadata on timeout/connection loss as well as tab close.
  void chrome.runtime.sendMessage({ type: 'GAF_REMOTE_END' }).catch(() => {});
  for (const timer of timers) clearInterval(timer);
  drawing.clearRect(0, 0, screen.width, screen.height);
  clearInvitation();
  for (const el of document.querySelectorAll('button,input,select')) el.disabled = true;
  status(message);
  session = null;
}
async function input(action) {
  // Preserve typed characters and click/key ordering even over a slow connection.
  inputTail = inputTail.catch(() => {}).then(async () => {
    if (!stopped) await request('input', { method: 'POST', body: action });
  });
  try { await inputTail; } catch { status('That action could not complete. Retry, or check whether the session ended.'); }
}
async function refreshState() {
  if (stopped) return;
  const state = await request('state');
  if (stopped) return;
  connectionOk();
  // A poll started before Take over must not repaint the older grant afterward.
  if (state.accessRevision < accessRevision) return;
  const active = state.pages.find(p => p.id === state.active);
  const url = active?.url || '';
  if (document.activeElement !== $('url') && $('url').value !== url) $('url').value = url;
  // The window list is rebuilt only when it actually changed, and never while
  // its menu may be open.
  const signature = state.pages.map(p => `${p.id}\u0000${p.title || p.url}`).join('\n') + `\n${state.active}`;
  if (signature !== pagesSignature && document.activeElement !== $('pages')) {
    pagesSignature = signature;
    $('pages').replaceChildren(...state.pages.map(p => new Option(p.title || p.url || 'Opening…', p.id)));
    $('pages').value = state.active;
  }
  const single = state.pages.length < 2;
  if ($('closePopup').disabled !== single) $('closePopup').disabled = single;
  setText($('permission'), state.access === 'off' ? 'Agent access off' : `${state.agent} · ${state.access === 'read' ? 'read only' : 'can interact'}`);
  setText($('lifetime'), `Idle timeout in ${Math.ceil(state.idleSecondsLeft / 60)} min`);
}
let pagesSignature = '';
let framing = false;
async function frame() {
  if (stopped || framing || document.hidden) return;
  framing = true;
  try {
    const response = await fetch(`${session.endpoint}/sessions/${session.id}/frame`, {
      headers: { Authorization: `Bearer ${session.ownerToken}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (response.status === 410) return finish('Session ended. Close this tab and start a fresh session from GAF.');
    if (!response.ok) throw new Error('Frame unavailable');
    const bitmap = await createImageBitmap(await response.blob());
    if (!stopped) drawing.drawImage(bitmap, 0, 0, screen.width, screen.height);
    bitmap.close();
    // A painted frame ends the wait (it used to stay up for the whole session).
    if (!stopped && $('status').textContent === WAITING) status('');
  } catch { if (!stopped) status(WAITING); }
  finally { framing = false; }
}

async function setAccess(access) {
  const revision = ++accessRevision;
  clearInvitation();
  if (access === 'off') {
    setRadio('access', 'off');
    setText($('permission'), 'Revoking agent access…');
  }
  const result = await request('grant', { method: 'POST', body: { access, agent: radioValue('agent'), revision } });
  if (stopped || revision !== accessRevision) return;
  setRadio('access', access);
  if (result.agentToken) {
    $('invitation').hidden = false;
    $('invitation').open = true;
    $('mcpUrl').value = `${session.endpoint}/mcp`;
    $('agentToken').value = result.agentToken;
  }
  await refreshState();
  if (stopped || revision !== accessRevision) return;
  status(access === 'off' ? 'You have control. Agent access revoked; an action already in progress may finish.' : 'Access granted. Connect the selected agent using the temporary invitation below.');
}

async function init() {
  const response = await chrome.runtime.sendMessage({ type: 'GAF_REMOTE_RECORD' });
  if (!response?.ok || !response.session) return finish('No active session. Open a website and choose Reload this URL remotely in GAF.');
  session = response.session;
  setText($('route'), `Route: ${session.routeName} · ${new URL(session.endpoint).host}`);
  const state = await request('state');
  accessRevision = state.accessRevision;
  if (state.agents.length) {
    $('agents').replaceChildren(...state.agents.map((name, i) => {
      const label = document.createElement('label');
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'agent', value: name, checked: i === 0 });
      const text = document.createElement('span');
      text.textContent = name;
      label.append(radio, text);
      return label;
    }));
  } else {
    $('agents').replaceChildren(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Add agents in GAF Options' }));
    $('grant').disabled = true;
    for (const radio of document.querySelectorAll('input[name="access"]')) radio.disabled = true;
  }
  // Reloading the viewer returns control to its user; never silently keep an old invitation.
  await setAccess('off');
  await heartbeat();
  await frame();
  await refreshState();
  timers.push(setInterval(frame, 400));
  timers.push(setInterval(() => refreshState().catch(connectionProblem), 2500));
  timers.push(setInterval(() => heartbeat().catch(connectionProblem), 10_000));

  $('navigate').addEventListener('submit', event => { event.preventDefault(); void input({ type: 'navigate', url: $('url').value }); });
  $('back').onclick = () => input({ type: 'back' });
  $('reload').onclick = () => input({ type: 'reload' });
  $('pages').onchange = () => input({ type: 'selectPage', id: $('pages').value });
  $('closePopup').onclick = () => input({ type: 'closePopup' });
  $('grant').onclick = () => setAccess(radioValue('access')).catch(() => status('Could not grant access. Choose an agent and retry.'));
  $('takeover').onclick = () => setAccess('off').catch(() => status('Could not confirm revocation. End the session to disconnect.'));
  $('revealToken').onclick = () => { const showing = $('agentToken').type === 'password'; $('agentToken').type = showing ? 'text' : 'password'; $('revealToken').textContent = showing ? 'Hide token' : 'Show token'; };
  $('end').onclick = async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GAF_REMOTE_END' });
      finish(result?.ok ? 'Session ended. Its browser and related windows have been closed.' : 'Session disconnected. Remote cleanup follows when the owner lease expires.');
    } catch { finish('Session disconnected. Remote cleanup follows when the owner lease expires.'); }
  };
  screen.addEventListener('click', event => {
    // Focus for typing without scrolling the viewer: a plain focus() scrolled
    // the toolbars out of view (issue #22).
    screen.focus({ preventScroll: true });
    const rect = screen.getBoundingClientRect();
    void input({ type: 'click', x: (event.clientX - rect.left) * 1280 / rect.width, y: (event.clientY - rect.top) * 800 / rect.height });
  });
  screen.addEventListener('wheel', event => { event.preventDefault(); void input({ type: 'scroll', dy: event.deltaY }); }, { passive: false });
  screen.addEventListener('keydown', event => {
    // Let browser/window shortcuts (especially closing the tab) stay local.
    if (event.metaKey || (event.ctrlKey && !['a', 'A'].includes(event.key))) return;
    event.preventDefault();
    if (event.ctrlKey) void input({ type: 'key', key: 'Control+a' });
    else if (event.key.length === 1) void input({ type: 'text', text: event.key });
    else if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void input({ type: 'key', key: `${event.shiftKey ? 'Shift+' : ''}${event.key}` });
  });
  screen.addEventListener('paste', event => { event.preventDefault(); void input({ type: 'text', text: event.clipboardData.getData('text/plain') }); });
}
init().catch(() => finish('Could not connect to the session. Start a fresh session from GAF.'));
