import {
  hostListToText,
  parseHostList,
  normalizeSettings,
  buildExportPack,
  parseImportPack,
} from '../core/settings.mjs';
import {
  loadSettings,
  saveSettings,
  resetSettings,
  loadExclusions,
  saveExclusions,
  loadArchive,
  saveArchive,
} from '../core/storage.mjs';
import { updateExclusion, removeExclusion } from '../core/exclusions.mjs';
import {
  hideRuleCandidatesFromEntry,
  pickBestHideCandidate,
  addGlobalHideRule,
  addHostHideRule,
  markArchiveEntryRuleAdded,
  updateArchiveEntry,
} from '../core/hide-from-archive.mjs';
import { bindUpdateControls, readInstalledVersion, extensionsPageUrl } from '../core/updates.mjs';

const $ = (id) => document.getElementById(id);

let exclusions = [];
let archive = [];
let currentSettings = null;

function fill(s) {
  $('enabled').checked = s.enabled;
  $('freezeImages').checked = s.freezeImages;
  $('videoPolicy').value = s.videoPolicy;
  $('useDefaultNewsHosts').checked = s.useDefaultNewsHosts;
  $('newsHosts').value = hostListToText(s.newsHosts);
  $('motionLevel').value = s.motionLevel;
  $('pauseScriptedMotion').checked = s.pauseScriptedMotion;
  $('elementHiding').checked = s.elementHiding;
  $('useDefaultHideRules').checked = s.useDefaultHideRules;
  $('hideRules').value = (s.hideRules || []).join('\n');
  $('timeFreezeMode').value = s.timeFreezeMode;
  $('timeFreezeScope').value = s.timeFreezeScope || 'softwall';
  $('timeFreezeSlowFactor').value = s.timeFreezeSlowFactor;
  $('timeFreezeMinMs').value = s.timeFreezeMinMs ?? 2000;
  $('timeFreezeSnapshot').checked = s.timeFreezeSnapshot;
  $('timeFreezeSnapshotDelayMs').value = s.timeFreezeSnapshotDelayMs;
  $('useDefaultSoftwallHosts').checked = s.useDefaultSoftwallHosts;
  $('softwallHosts').value = hostListToText(s.softwallHosts);
  $('meterResetEnabled').checked = s.meterResetEnabled !== false;
  $('meterResetMode').value = s.meterResetMode || 'auto';
  $('meterResetScope').value = s.meterResetScope || 'softwall';
  $('meterResetCookieMode').value = s.meterResetCookieMode || 'meter-names';
  $('meterResetClearStorage').checked = s.meterResetClearStorage !== false;
  $('meterResetClearDurableStorage').checked = Boolean(s.meterResetClearDurableStorage);
  $('meterDisarm').checked = s.meterDisarm !== false;
  $('denyHosts').value = hostListToText(s.denyHosts);
  $('customCss').checked = s.customCss;
  $('siteCssJson').value = JSON.stringify(s.siteCss || {}, null, 2);
}

function read() {
  let siteCss = {};
  try {
    siteCss = JSON.parse($('siteCssJson').value || '{}');
    if (!siteCss || typeof siteCss !== 'object' || Array.isArray(siteCss)) {
      throw new Error('site CSS must be a JSON object');
    }
  } catch (e) {
    throw new Error(`Site CSS JSON: ${e.message}`);
  }

  return normalizeSettings({
    enabled: $('enabled').checked,
    freezeImages: $('freezeImages').checked,
    videoPolicy: $('videoPolicy').value,
    useDefaultNewsHosts: $('useDefaultNewsHosts').checked,
    newsHosts: parseHostList($('newsHosts').value),
    motionLevel: $('motionLevel').value,
    pauseScriptedMotion: $('pauseScriptedMotion').checked,
    elementHiding: $('elementHiding').checked,
    useDefaultHideRules: $('useDefaultHideRules').checked,
    hideRules: $('hideRules').value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    timeFreezeMode: $('timeFreezeMode').value,
    timeFreezeScope: $('timeFreezeScope').value,
    timeFreezeSlowFactor: Number($('timeFreezeSlowFactor').value),
    timeFreezeMinMs: Number($('timeFreezeMinMs').value),
    timeFreezeSnapshot: $('timeFreezeSnapshot').checked,
    timeFreezeSnapshotDelayMs: Number($('timeFreezeSnapshotDelayMs').value),
    useDefaultSoftwallHosts: $('useDefaultSoftwallHosts').checked,
    softwallHosts: parseHostList($('softwallHosts').value),
    meterResetEnabled: $('meterResetEnabled').checked,
    meterResetMode: $('meterResetMode').value,
    meterResetScope: $('meterResetScope').value,
    meterResetCookieMode: $('meterResetCookieMode').value,
    meterResetClearStorage: $('meterResetClearStorage').checked,
    meterResetClearDurableStorage: $('meterResetClearDurableStorage').checked,
    meterDisarm: $('meterDisarm').checked,
    denyHosts: parseHostList($('denyHosts').value),
    customCss: $('customCss').checked,
    siteCss,
  });
}

function toast(msg) {
  const el = $('toast');
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function renderBacklog() {
  const root = $('backlogList');
  root.innerHTML = '';
  const open = exclusions.filter((e) => e.status !== 'resolved');
  const resolved = exclusions.filter((e) => e.status === 'resolved');
  const all = [...open, ...resolved];
  $('backlogEmpty').hidden = all.length > 0;

  for (const e of all) {
    const card = document.createElement('article');
    card.className = 'item';
    card.innerHTML = `
      <header>
        <strong>${escapeHtml(e.host)}</strong>
        <span class="badge status-${escapeHtml(e.status)}">${escapeHtml(e.status)}</span>
      </header>
      <p class="meta">${escapeHtml(e.reason || '')}</p>
      <p class="meta muted">${escapeHtml(e.note || '')}</p>
      <p class="meta muted">
        ${e.urlSample ? `<a href="${escapeAttr(e.urlSample)}" target="_blank" rel="noreferrer">sample URL</a> · ` : ''}
        ${escapeHtml(e.createdAt || '')} · ${escapeHtml(e.source || '')}
      </p>
      <label class="note-label">Note
        <textarea data-id="${escapeAttr(e.id)}" class="ex-note" rows="2">${escapeHtml(e.note || '')}</textarea>
      </label>
      <div class="item-actions">
        <button type="button" data-act="reviewing" data-id="${escapeAttr(e.id)}" class="btn">Mark reviewing</button>
        <button type="button" data-act="resolved" data-id="${escapeAttr(e.id)}" class="btn">Resolved (filter again)</button>
        <button type="button" data-act="open" data-id="${escapeAttr(e.id)}" class="btn">Re-open</button>
        <button type="button" data-act="remove" data-id="${escapeAttr(e.id)}" class="btn">Remove</button>
      </div>
    `;
    root.appendChild(card);
  }

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      if (act === 'remove') {
        exclusions = removeExclusion(exclusions, id);
      } else if (act === 'resolved') {
        exclusions = updateExclusion(exclusions, id, { status: 'resolved' });
      } else if (act === 'reviewing') {
        exclusions = updateExclusion(exclusions, id, { status: 'reviewing' });
      } else if (act === 'open') {
        exclusions = updateExclusion(exclusions, id, { status: 'open' });
      }
      await saveExclusions(exclusions);
      try {
        await chrome.runtime.sendMessage({ type: 'GAF_SAVE_EXCLUSIONS', exclusions });
      } catch {
        /* ignore */
      }
      renderBacklog();
      toast('Backlog updated.');
    });
  });

  root.querySelectorAll('.ex-note').forEach((ta) => {
    ta.addEventListener('change', async () => {
      const id = ta.getAttribute('data-id');
      exclusions = updateExclusion(exclusions, id, { note: ta.value });
      await saveExclusions(exclusions);
    });
  });
}

function renderArchive() {
  const root = $('archiveList');
  root.innerHTML = '';
  $('archiveEmpty').hidden = archive.length > 0;

  for (const e of archive) {
    const hints = (e.hints || [])
      .map(
        (h) =>
          `<li><code>${escapeHtml(h.code)}</code> — ${escapeHtml(h.message)}${
            h.detail ? `<br><span class="muted">${escapeHtml(String(h.detail).slice(0, 180))}</span>` : ''
          }</li>`
      )
      .join('');

    const candidates = hideRuleCandidatesFromEntry(e);
    const best = pickBestHideCandidate(e);
    const optionsHtml = candidates.length
      ? candidates
          .map((c, i) => {
            const selected = best && c.selector === best.selector ? ' selected' : i === 0 ? ' selected' : '';
            return `<option value="${escapeAttr(c.selector)}"${selected}>[${escapeHtml(c.strength)}] ${escapeHtml(c.label)} — ${escapeHtml(c.selector)}</option>`;
          })
          .join('')
      : '<option value="">(no safe selector derived)</option>';

    const already = e.hideRuleAdded
      ? `<p class="meta badge-line"><span class="badge status-resolved">rule added</span> <code>${escapeHtml(e.hideRuleAdded.selector)}</code> (${escapeHtml(e.hideRuleAdded.scope)})</p>`
      : '';

    const card = document.createElement('article');
    card.className = 'item';
    card.dataset.archiveId = e.id;
    card.innerHTML = `
      <header>
        <strong>&lt;${escapeHtml(e.tagName)}&gt;</strong>
        <span class="badge">${escapeHtml(e.host || '')}</span>
      </header>
      <p class="meta"><code>${escapeHtml(e.selectorHint || '')}</code></p>
      <p class="meta muted">${escapeHtml(e.createdAt || '')}
        ${e.pageUrl ? ` · <a href="${escapeAttr(e.pageUrl)}" target="_blank" rel="noreferrer">page</a>` : ''}
      </p>
      <p class="meta">${escapeHtml(e.textSample || '')}</p>
      ${already}
      <div class="hide-from-archive">
        <label class="stack-label">Hide selector
          <select class="hide-selector" data-id="${escapeAttr(e.id)}">${optionsHtml}</select>
        </label>
        <label class="stack-label">Or edit
          <input type="text" class="hide-selector-edit" data-id="${escapeAttr(e.id)}" value="${escapeAttr(best?.selector || '')}" spellcheck="false" />
        </label>
        <div class="item-actions">
          <button type="button" class="btn primary" data-hide-global="${escapeAttr(e.id)}" ${candidates.length ? '' : 'disabled'}>
            Add global hide rule
          </button>
          <button type="button" class="btn" data-hide-host="${escapeAttr(e.id)}" ${candidates.length && e.host ? '' : 'disabled'}>
            Hide on this host only
          </button>
          <button type="button" class="btn" data-del="${escapeAttr(e.id)}">Delete</button>
        </div>
        <p class="hint tight">
          Global goes into element-hide rules (all sites). Host-only appends CSS for
          <code>${escapeHtml(e.host || '—')}</code> — safer when the selector might match elsewhere.
        </p>
      </div>
      <details>
        <summary>Escape hints &amp; HTML</summary>
        <ul class="hints">${hints}</ul>
        <pre class="code">${escapeHtml(e.outerHtml || '')}</pre>
      </details>
    `;
    root.appendChild(card);
  }

  // Sync select → edit field
  root.querySelectorAll('.hide-selector').forEach((sel) => {
    sel.addEventListener('change', () => {
      const id = sel.getAttribute('data-id');
      const input = root.querySelector(`.hide-selector-edit[data-id="${CSS.escape(id)}"]`);
      if (input) input.value = sel.value;
    });
  });

  root.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-del');
      archive = archive.filter((x) => x.id !== id);
      await saveArchive(archive);
      renderArchive();
    });
  });

  root.querySelectorAll('[data-hide-global]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-hide-global');
      await promoteHideRule(id, 'global');
    });
  });

  root.querySelectorAll('[data-hide-host]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-hide-host');
      await promoteHideRule(id, 'host');
    });
  });
}

function selectorForArchiveId(id) {
  const root = $('archiveList');
  const edit = root.querySelector(`.hide-selector-edit[data-id="${CSS.escape(id)}"]`);
  const sel = root.querySelector(`.hide-selector[data-id="${CSS.escape(id)}"]`);
  return (edit?.value || sel?.value || '').trim();
}

async function promoteHideRule(archiveId, scope) {
  const entry = archive.find((x) => x.id === archiveId);
  if (!entry) {
    toast('Archive entry not found.');
    return;
  }
  const selector = selectorForArchiveId(archiveId);
  if (!selector) {
    toast('Choose or type a selector first.');
    return;
  }

  let settings = currentSettings || (await loadSettings());
  let result;
  if (scope === 'host') {
    if (!entry.host) {
      toast('No host on this entry — use global hide instead.');
      return;
    }
    result = addHostHideRule(settings, entry.host, selector);
  } else {
    result = addGlobalHideRule(settings, selector);
  }

  if (result.alreadyHad) {
    toast(scope === 'host' ? 'That host CSS already contains this selector.' : 'That hide rule is already in your list.');
  } else if (result.added) {
    currentSettings = await saveSettings(result.settings);
    fill(currentSettings);
    try {
      await chrome.runtime.sendMessage({ type: 'GAF_SAVE_SETTINGS', settings: currentSettings });
    } catch {
      /* ignore */
    }
    toast(
      scope === 'host'
        ? `Host hide added for ${entry.host}. Reload the tab to apply.`
        : 'Global hide rule added. Reload the tab to apply.'
    );
  } else {
    toast('Could not add hide rule.');
    return;
  }

  const marked = markArchiveEntryRuleAdded(entry, {
    selector,
    scope,
    host: entry.host,
  });
  archive = updateArchiveEntry(archive, archiveId, marked);
  await saveArchive(archive);
  renderArchive();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    });
  });
}

function setupUpdates() {
  bindUpdateControls({
    checkButton: $('checkUpdates'),
    updateButton: $('applyUpdate'),
    statusElement: $('updateStatus'),
    installedVersionElements: [$('installedEyebrow'), $('installedVersion'), $('footerVersion')],
    getInstalledVersion: readInstalledVersion,
    openUrl: (url) => chrome.tabs.create({ url }),
    getExtensionsPageUrl: () => extensionsPageUrl(navigator.userAgent || ''),
  });
}

async function init() {
  setupTabs();
  setupUpdates();
  currentSettings = await loadSettings();
  fill(currentSettings);
  exclusions = await loadExclusions();
  archive = await loadArchive();
  renderBacklog();
  renderArchive();

  $('save').addEventListener('click', async () => {
    try {
      const next = await saveSettings(read());
      currentSettings = next;
      fill(next);
      try {
        await chrome.runtime.sendMessage({ type: 'GAF_SAVE_SETTINGS', settings: next });
      } catch {
        /* ignore */
      }
      toast('Saved.');
    } catch (e) {
      toast(String(e.message || e));
    }
  });

  $('reset').addEventListener('click', async () => {
    if (!confirm('Reset all GAF settings to defaults? (Backlog & archive are kept.)')) return;
    const next = await resetSettings();
    currentSettings = next;
    fill(next);
    try {
      await chrome.runtime.sendMessage({ type: 'GAF_SAVE_SETTINGS', settings: next });
    } catch {
      /* ignore */
    }
    toast('Defaults restored.');
  });

  $('refreshArchive').addEventListener('click', async () => {
    archive = await loadArchive();
    renderArchive();
    toast('Archive refreshed.');
  });

  $('clearArchive').addEventListener('click', async () => {
    if (!confirm('Clear the entire inspection archive?')) return;
    archive = [];
    await saveArchive([]);
    renderArchive();
    toast('Archive cleared.');
  });

  $('exportPack').addEventListener('click', async () => {
    const s = await loadSettings();
    const ex = await loadExclusions();
    const pack = buildExportPack(s, ex);
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gaf-filter-pack-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported.');
  });

  $('importPack').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { settings: s, exclusions: ex } = parseImportPack(text);
      await saveSettings(s);
      await saveExclusions(ex);
      fill(s);
      exclusions = ex;
      renderBacklog();
      try {
        await chrome.runtime.sendMessage({ type: 'GAF_SAVE_SETTINGS', settings: s });
        await chrome.runtime.sendMessage({ type: 'GAF_SAVE_EXCLUSIONS', exclusions: ex });
      } catch {
        /* ignore */
      }
      toast('Imported filter pack.');
    } catch (e) {
      toast(`Import failed: ${e.message || e}`);
    }
    ev.target.value = '';
  });
}

init().catch((err) => {
  toast(`Failed to load: ${err?.message || err}`);
});
