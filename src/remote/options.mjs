import { loadRemoteSettings, saveRemoteSettings } from '../core/remote-session.mjs';

export async function setupRemoteOptions() {
  const $ = id => document.getElementById(id);
  let settings = await loadRemoteSettings();
  const root = $('remoteConnections');
  function defaults() {
    const chosen = $('remoteDefault').value;
    $('remoteDefault').replaceChildren();
    for (const row of root.children) $('remoteDefault').add(new Option(row.querySelector('[data-field=name]').value || 'Remote connection', row.dataset.id));
    if ([...$('remoteDefault').options].some(o => o.value === chosen)) $('remoteDefault').value = chosen;
  }
  function add(provider = { id: crypto.randomUUID(), name: '', endpoint: 'http://127.0.0.1:8765', token: '' }) {
    const row = document.createElement('fieldset');
    row.dataset.id = provider.id;
    row.style.marginBottom = '16px';
    const legend = document.createElement('legend'); legend.textContent = 'Connection'; row.append(legend);
    for (const [key, label, type] of [['name', 'Connection name', 'text'], ['endpoint', 'Server address', 'url'], ['token', 'Connection key', 'password']]) {
      const field = document.createElement('label'); field.className = 'field stack';
      const text = document.createElement('strong'); text.textContent = label;
      const input = document.createElement('input'); input.type = type; input.dataset.field = key;
      input.value = provider[key]; input.autocomplete = 'off'; input.spellcheck = false;
      if (key === 'name') input.addEventListener('input', defaults);
      field.append(text, input); row.append(field);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn'; remove.textContent = 'Remove connection';
    remove.addEventListener('click', () => { row.remove(); defaults(); }); row.append(remove);
    root.append(row); defaults();
  }
  for (const p of settings.providers) add(p);
  $('remoteDefault').value = settings.defaultProvider;
  $('remoteTimeout').value = settings.idleMinutes;
  $('remoteAgents').value = settings.agents.join('\n');
  $('remoteAdd').addEventListener('click', () => add());
  $('remoteSave').addEventListener('click', async () => {
    try {
      settings = await saveRemoteSettings({
        providers: [...root.children].map(row => Object.fromEntries([
          ['id', row.dataset.id], ...[...row.querySelectorAll('input')].map(input => [input.dataset.field, input.value]),
        ])),
        defaultProvider: $('remoteDefault').value, idleMinutes: $('remoteTimeout').value,
        agents: $('remoteAgents').value.split('\n'),
      });
      $('remoteSettingsStatus').textContent = 'Saved locally. New sessions use these settings; existing sessions keep their connection.';
    } catch (error) { $('remoteSettingsStatus').textContent = error.message; }
  });
}
