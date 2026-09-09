import { normalizeHost, resolveSitePolicy } from '../core/settings.mjs';
import { loadSettings, saveSettings, loadExclusions, verifySettingsEnabled } from '../core/storage.mjs';
import { findExclusionForHost, removeExclusion, activeExclusionHosts } from '../core/exclusions.mjs';
import { paintActionBadge, isBadgeOn } from '../core/badge.mjs';
import { bindUpdateControls, readInstalledVersion, extensionsPageUrl } from '../core/updates.mjs';

const $ = (id) => document.getElementById(id);

let settings = null;
let exclusions = [];
let currentHost = '';
let currentUrl = '';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTopFrame(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

function hostFromTab(tab) {
  try {
    if (!tab?.url) return '';
    return normalizeHost(new URL(tab.url).hostname);
  } catch {
    return '';
  }
}

function paintMasterChrome(enabled) {
  const on = Boolean(enabled);
  const logo = $('brandLogo');
  if (logo) logo.classList.toggle('is-off', !on);
  document.body.classList.toggle('gaf-master-on', on);
  document.body.classList.toggle('gaf-master-off', !on);
  const tag = $('brandTagline');
  if (tag) {
    tag.textContent = on
      ? 'Filtering ON — toolbar icon green'
      : 'Filtering OFF — toolbar icon grey + red slash';
  }
}

function fillForm(s) {
  $('enabled').checked = s.enabled;
  $('freezeImages').checked = s.freezeImages;
  $('videoPolicy').value = s.videoPolicy;
  $('motionLevel').value = s.motionLevel;
  $('timeFreezeMode').value = s.timeFreezeMode;
  $('elementHiding').checked = s.elementHiding;
  $('pauseScriptedMotion').checked = s.pauseScriptedMotion;
  paintMasterChrome(s.enabled);
}

function readForm() {
  return {
    enabled: $('enabled').checked,
    freezeImages: $('freezeImages').checked,
    videoPolicy: $('videoPolicy').value,
    motionLevel: $('motionLevel').value,
    timeFreezeMode: $('timeFreezeMode').value,
    elementHiding: $('elementHiding').checked,
    pauseScriptedMotion: $('pauseScriptedMotion').checked,
  };
}

function updateStatus(s, host) {
  const hosts = activeExclusionHosts(exclusions);
  const policy = host
    ? resolveSitePolicy(`https://${host}/`, s, hosts)
    : { active: s.enabled, reason: 'default' };
  const on = s.enabled && policy.active;
  let extra = '';
  if (!s.enabled) {
    extra =
      'Master switch OFF — toolbar icon is grey with a red slash. Flip the green slider on.';
  } else if (policy.reason === 'excluded') {
    extra = 'Site is in the exclusion backlog (review later).';
  } else if (policy.reason === 'deny-list') extra = 'Force-filtered.';
  else extra = 'Filtering ON — toolbar icon is green.';

  $('statusLine').innerHTML = on
    ? `<strong>Filtering</strong> — ${extra}`
    : `<strong style="color:#b45309">Idle</strong> — ${extra}`;

  paintMasterChrome(s.enabled);

  $('siteHost').textContent = host || '(no host)';
  const ex = host ? findExclusionForHost(exclusions, host) : null;
  const onDeny = host && s.denyHosts.includes(host);
  $('clearSite').classList.toggle('hidden', !ex && !onDeny);
  $('excludeSite').disabled = !host;
  $('denySite').disabled = !host;
}

async function persist(partial) {
  const wanted = { ...settings, ...partial };
  settings = await saveSettings(wanted);
  // Re-read from storage so we show what actually stuck (catches sync/local bugs)
  settings = await loadSettings();
  fillForm(settings);
  updateStatus(settings, currentHost);

  const enabledNow = Boolean(settings.enabled);
  try {
    await paintActionBadge(enabledNow);
  } catch {
    /* ignore */
  }
  try {
    await chrome.runtime.sendMessage({ type: 'GAF_SYNC_BADGE' });
  } catch {
    /* ignore */
  }
  try {
    const tab = await getActiveTab();
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'GAF_SETTINGS',
        settings,
        exclusionHosts: activeExclusionHosts(exclusions),
      });
    }
  } catch {
    /* ignore */
  }

  // Explicit feedback after master toggle
  if ('enabled' in partial) {
    const verified = await verifySettingsEnabled();
    if (partial.enabled && !verified) {
      $('statusLine').innerHTML =
        '<strong style="color:#b91c1c">Save failed</strong> — setting did not stick. Reload GAF from Extensions.';
    } else if (partial.enabled && verified) {
      $('statusLine').innerHTML =
        '<strong>Filtering on</strong> — toolbar icon should turn <strong>green</strong>.';
    } else {
      $('statusLine').innerHTML =
        '<strong>Filtering off</strong> — toolbar icon should turn <strong>grey with red slash</strong>.';
    }
  }
  return settings;
}

async function init() {
  settings = await loadSettings();
  exclusions = await loadExclusions();
  fillForm(settings);

  // Paint badge from popup too (clears stuck per-tab OFF/OK/EX overrides)
  try {
    await paintActionBadge(isBadgeOn(settings.enabled));
  } catch {
    /* ignore */
  }
  try {
    await chrome.runtime.sendMessage({ type: 'GAF_SYNC_BADGE' });
  } catch {
    /* ignore */
  }

  const tab = await getActiveTab();
  currentHost = hostFromTab(tab);
  currentUrl = tab?.url || '';
  updateStatus(settings, currentHost);

  const saveFromForm = () => persist(readForm());

  $('enabled').addEventListener('change', saveFromForm);
  $('freezeImages').addEventListener('change', saveFromForm);
  $('videoPolicy').addEventListener('change', saveFromForm);
  $('motionLevel').addEventListener('change', saveFromForm);
  $('timeFreezeMode').addEventListener('change', saveFromForm);
  $('elementHiding').addEventListener('change', saveFromForm);
  $('pauseScriptedMotion').addEventListener('change', saveFromForm);

  $('excludeSite').addEventListener('click', async () => {
    if (!currentHost) return;
    await chrome.runtime.sendMessage({
      type: 'GAF_EXCLUDE_HOST',
      host: currentHost,
      urlSample: currentUrl,
      reason: 'Excluded via popup — site misbehaved under GAF',
      note: 'Open Options → Exclusion backlog to review and re-enable.',
      source: 'popup',
    });
    exclusions = await loadExclusions();
    updateStatus(settings, currentHost);
    try {
      const t = await getActiveTab();
      if (t?.id) await chrome.tabs.sendMessage(t.id, { type: 'GAF_EXCLUSIONS_CHANGED' });
    } catch {
      /* ignore */
    }
    $('statusLine').innerHTML =
      '<strong>Excluded</strong> — added to review backlog. Filtering off for this host.';
  });

  $('denySite').addEventListener('click', async () => {
    if (!currentHost) return;
    const denyHosts = [...new Set([...settings.denyHosts, currentHost])];
    // Remove exclusion if any so deny wins cleanly
    const ex = findExclusionForHost(exclusions, currentHost);
    if (ex) {
      exclusions = removeExclusion(exclusions, ex.id);
      await chrome.runtime.sendMessage({ type: 'GAF_SAVE_EXCLUSIONS', exclusions });
    }
    await persist({ denyHosts });
  });

  $('clearSite').addEventListener('click', async () => {
    if (!currentHost) return;
    const ex = findExclusionForHost(exclusions, currentHost);
    if (ex) {
      exclusions = removeExclusion(exclusions, ex.id);
      await chrome.runtime.sendMessage({ type: 'GAF_SAVE_EXCLUSIONS', exclusions });
    }
    await persist({
      denyHosts: settings.denyHosts.filter((h) => h !== currentHost),
    });
    exclusions = await loadExclusions();
    updateStatus(settings, currentHost);
  });

  $('snapshotNow').addEventListener('click', async () => {
    try {
      const t = await getActiveTab();
      if (!t?.id) return;
      await sendToTopFrame(t.id, { type: 'GAF_SNAPSHOT_NOW' });
      $('statusLine').innerHTML = '<strong>Snapshot</strong> — reading freeze overlay applied.';
    } catch {
      $('statusLine').textContent = 'Cannot snapshot this page.';
    }
  });

  $('thawNow').addEventListener('click', async () => {
    try {
      const t = await getActiveTab();
      if (!t?.id) return;
      // Prefer early force-unlock (no module import), then full thaw
      let early = null;
      try {
        const inj = await chrome.scripting.executeScript({
          target: { tabId: t.id, frameIds: [0] },
          func: () => {
            if (typeof globalThis.__gafForceUnlock === 'function') {
              return globalThis.__gafForceUnlock();
            }
            // Inline fallback if early script missing
            document.documentElement.classList.add('gaf-force-unlock');
            document.body?.classList?.remove?.(
              'noscroll',
              'phantom-scroll-bar',
              'overflow-hidden',
              'modal-open',
              'no-scroll',
            );
            document.body && (document.body.style.overflow = '');
            // Never nuke video players (YouTube fullscreen uses full-viewport fixed layers)
            const host = (location.hostname || '').replace(/^www\./, '');
            if (/(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|netflix\.com)$/i.test(host)) {
              return { reason: 'skipped-media' };
            }
            for (const el of document.querySelectorAll(
              '#cookie-popup, #ditur-popup-container, [class*="bg-gray-500/75"]',
            )) {
              el.style.setProperty('display', 'none', 'important');
              el.style.setProperty('pointer-events', 'none', 'important');
            }
            return { reason: 'inline-fallback' };
          },
        });
        early = inj?.[0]?.result;
      } catch {
        /* scripting may need activeTab — fall through to message */
      }
      const res = await sendToTopFrame(t.id, { type: 'GAF_THAW' }).catch(() => null);
      const u = res?.unstick;
      if (early || u?.reason === 'consent-force-uncover' || u?.seeded) {
        $('statusLine').innerHTML =
          '<strong>Uncovered</strong> — grey / cookie lock force-cleared.';
      } else if (u?.reason === 'consent-dismissed' && u?.consent?.button) {
        const line = $('statusLine');
        line.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = 'Uncovered';
        line.append(strong, ` — dismissed cookie wall (“${u.consent.button}”).`);
      } else if (u?.cleared > 0 || u?.unlocked) {
        $('statusLine').innerHTML = '<strong>Uncovered</strong> — grey overlay / scroll lock cleared.';
      } else {
        $('statusLine').innerHTML = '<strong>Thawed</strong> — live page restored.';
      }
    } catch {
      $('statusLine').textContent = 'Cannot thaw this page.';
    }
  });

  $('resetMeter').addEventListener('click', async () => {
    try {
      const t = await getActiveTab();
      if (!t?.id || !t.url) {
        $('statusLine').textContent = 'No active tab.';
        return;
      }
      const allCookies = settings?.meterResetCookieMode === 'all';
      const durable = Boolean(settings?.meterResetClearDurableStorage);
      if (allCookies || durable) {
        const bits = [];
        if (allCookies) bits.push('all cookies visible to this page (you may be logged out)');
        if (durable) bits.push('IndexedDB and Cache Storage');
        if (!confirm(`Reset meter will clear ${bits.join(' and ')}. Continue?`)) {
          return;
        }
      }
      $('statusLine').textContent = 'Disarming gate + clearing meter cookies…';
      const result = await chrome.runtime.sendMessage({
        type: 'GAF_RESET_METER',
        tabId: t.id,
        url: t.url,
        // Prefer disarm-in-place; SW skips reload when article body is already present
        reload: false,
      });
      if (result?.ok) {
        const n = result.cookiesRemoved ?? 0;
        const store = result.storageCleared ? ' + storage' : '';
        const d = result.disarm;
        const disarmNote = d?.useful
          ? ` gate hidden (${d.articleChars || 0} chars body)`
          : d?.hidden
            ? ` gate hidden (body short: ${d.articleChars || 0} chars)`
            : '';
        const reloadNote = result.reloaded ? '; reloading' : ' — read in place';
        $('statusLine').innerHTML = `<strong>Meter reset</strong> — ${n} cookie(s)${store}${disarmNote}${reloadNote}.`;
        // If body was empty, force a reload after wipe
        if (!d?.useful && !result.reloaded) {
          await chrome.runtime.sendMessage({
            type: 'GAF_RESET_METER',
            tabId: t.id,
            url: t.url,
            forceReload: true,
            reload: true,
          });
          $('statusLine').innerHTML += ' Reloading for server body…';
        }
      } else {
        $('statusLine').textContent = `Meter reset failed: ${result?.error || 'unknown'}`;
      }
    } catch (e) {
      $('statusLine').textContent = `Meter reset failed: ${e?.message || e}`;
    }
  });

  $('runNow').addEventListener('click', async () => {
    try {
      const t = await getActiveTab();
      if (!t?.id) return;
      await sendToTopFrame(t.id, { type: 'GAF_RUN_NOW' });
      $('statusLine').innerHTML = '<strong>Re-applied</strong> on this tab.';
    } catch {
      $('statusLine').textContent = 'Cannot reach this page.';
    }
  });

  $('openOptions').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  bindUpdateControls({
    checkButton: $('checkUpdates'),
    updateButton: $('applyUpdate'),
    statusElement: $('updateStatus'),
    getInstalledVersion: readInstalledVersion,
    openUrl: (url) => chrome.tabs.create({ url }),
    getExtensionsPageUrl: () => extensionsPageUrl(navigator.userAgent || ''),
  });
}

init().catch((err) => {
  $('statusLine').textContent = `Error: ${err?.message || err}`;
});
