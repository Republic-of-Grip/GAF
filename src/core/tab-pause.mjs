/**
 * Pause GAF on a single tab.
 *
 * Lighter than the master switch (every tab) or an exclusion (a host, kept
 * as a review backlog). The pause lives in extension session storage keyed
 * by tab id, so it ends when the tab closes, when the user resumes it, or
 * when the browser restarts. It deliberately survives navigation inside the
 * tab: checkout flows redirect to a bank or 3-D Secure page and back, and a
 * pause that ended on the first redirect would not help there.
 *
 * Content scripts cannot read session storage or know their tab id, so they
 * ask the service worker (GAF_TAB_PAUSE_STATE); sender.tab.id answers for
 * every frame in the tab.
 */

export const TAB_PAUSE_PREFIX = 'gafTabPause:';
export const TAB_PAUSE_BADGE = { text: 'II', color: '#b45309' };

export function tabPauseKey(tabId) {
  return `${TAB_PAUSE_PREFIX}${tabId}`;
}

function validTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

/**
 * Settings as a content script should apply them on a paused tab: master off,
 * so every existing policy check (resolveSitePolicy etc.) treats the page as
 * inactive and the normal teardown path restores GAF-owned changes.
 */
export function effectiveSettingsForTab(settings, paused) {
  if (!paused) return settings;
  return { ...(settings || {}), enabled: false };
}

/**
 * @param {{ chromeApi: typeof chrome, now?: () => number }} deps
 */
export function createTabPause({ chromeApi, now = () => Date.now() }) {
  const session = chromeApi?.storage?.session;

  async function isPaused(tabId) {
    if (!validTabId(tabId) || !session) return false;
    try {
      const key = tabPauseKey(tabId);
      const data = await session.get(key);
      return Boolean(data?.[key]);
    } catch {
      // Unreadable state must never block filtering elsewhere; fail open to "not paused".
      return false;
    }
  }

  async function pausedTabIds() {
    if (!session) return [];
    try {
      const all = await session.get(null);
      return Object.keys(all || {})
        .filter((k) => k.startsWith(TAB_PAUSE_PREFIX) && all[k])
        .map((k) => Number(k.slice(TAB_PAUSE_PREFIX.length)))
        .filter(validTabId);
    } catch {
      return [];
    }
  }

  async function setPaused(tabId, paused, { url = '' } = {}) {
    if (!validTabId(tabId)) return { ok: false, error: 'invalid-tab' };
    if (!session) return { ok: false, error: 'session-storage-unavailable' };
    const key = tabPauseKey(tabId);
    if (paused) {
      await session.set({ [key]: { since: now(), url: String(url || '').slice(0, 500) } });
    } else {
      await session.remove(key);
    }
    return { ok: true, paused: Boolean(paused) };
  }

  async function paintTabBadge(tabId, paused) {
    const action = chromeApi?.action;
    if (!action || !validTabId(tabId)) return;
    try {
      if (paused) {
        await action.setBadgeBackgroundColor?.({ color: TAB_PAUSE_BADGE.color, tabId });
        await action.setBadgeText?.({ text: TAB_PAUSE_BADGE.text, tabId });
      } else {
        // Chromium stores '' as a per-tab blank, which hides the global ON/OFF.
        // null removes the per-tab text so the global badge shows again.
        await action.setBadgeText?.({ text: null, tabId });
        await restoreTabBadgeColor(action, tabId);
      }
    } catch {
      /* tab closed or badge API missing */
    }
  }

  /** Copy the global badge color onto one tab. Chromium has no null clear for color. */
  async function restoreTabBadgeColor(action, tabId) {
    if (!action.getBadgeBackgroundColor || !action.setBadgeBackgroundColor) return;
    const color = await action.getBadgeBackgroundColor({});
    if (!color) return;
    await action.setBadgeBackgroundColor({ color, tabId });
  }

  /** Re-apply per-tab badges after a global repaint cleared them. */
  async function repaintPausedBadges() {
    for (const tabId of await pausedTabIds()) {
      await paintTabBadge(tabId, true);
    }
  }

  async function forgetTab(tabId) {
    if (!validTabId(tabId) || !session) return;
    try {
      await session.remove(tabPauseKey(tabId));
    } catch {
      /* ignore */
    }
  }

  return { isPaused, pausedTabIds, setPaused, paintTabBadge, repaintPausedBadges, forgetTab };
}

/**
 * Service-worker message handling for the pause, kept here (a plain .mjs) so
 * it can be unit tested on every supported Node version.
 *
 * - GAF_TAB_PAUSE_STATE: any frame asks about its own tab (sender.tab.id);
 *   only extension pages (no sender.tab) may name another tab.
 * - GAF_SET_TAB_PAUSE: extension pages (the popup) only, never a page.
 *
 * @returns {Promise<object> | null} null when the message is not ours.
 */
export function handleTabPauseMessage(message, sender, { tabPause, notifyTab }) {
  if (message?.type === 'GAF_TAB_PAUSE_STATE') {
    const tabId = sender?.tab ? sender.tab.id : message.tabId;
    return tabPause
      .isPaused(tabId)
      .then((paused) => ({ ok: true, paused }))
      .catch(() => ({ ok: true, paused: false }));
  }
  if (message?.type === 'GAF_SET_TAB_PAUSE') {
    if (sender?.tab) return Promise.resolve({ ok: false, error: 'not-allowed-from-page' });
    const tabId = message.tabId;
    return tabPause
      .setPaused(tabId, Boolean(message.paused), { url: message.url })
      .then(async (result) => {
        if (result.ok) {
          await tabPause.paintTabBadge(tabId, result.paused);
          await notifyTab?.(tabId);
        }
        return result;
      })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  }
  return null;
}
