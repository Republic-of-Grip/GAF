/**
 * Toolbar visual state.
 *
 * Helium often ignores badge text AND sometimes path-based setIcon.
 * We therefore:
 *  1) draw ImageData icons (always works when action API exists)
 *  2) also try path-based setIcon as backup
 *  3) set badge text + tooltip
 *
 * ON  = bright green rounded tile
 * OFF = dark grey tile + thick red slash
 */

export const BADGE_ON = {
  text: 'ON',
  color: '#168246',
  title: 'GAF: filtering ON',
};

export const BADGE_OFF = {
  text: 'OFF',
  color: '#555555',
  title: 'GAF: filtering OFF — open popup and enable the master switch',
};

export const ICON_PATHS_ON = {
  16: 'icons/icon-on-16.png',
  32: 'icons/icon-on-32.png',
  48: 'icons/icon-on-48.png',
  128: 'icons/icon-on-128.png',
};

export const ICON_PATHS_OFF = {
  16: 'icons/icon-off-16.png',
  32: 'icons/icon-off-32.png',
  48: 'icons/icon-off-48.png',
  128: 'icons/icon-off-128.png',
};

/** @param {unknown} enabled */
export function isBadgeOn(enabled) {
  if (enabled === false || enabled === 0 || enabled === '0' || enabled === 'false') {
    return false;
  }
  return true;
}

/**
 * Draw a crisp 16/32 toolbar icon in-memory (no PNG path dependency).
 * @param {number} size
 * @param {boolean} on
 * @returns {ImageData|null}
 */
export function drawStateIcon(size, on) {
  try {
    // OffscreenCanvas is available in extension SW + modern extension pages
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size, size)
        : null;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const bg = on ? '#168246' : '#3a3a3e';
    const fg = on ? '#0a1a10' : '#1c1c1e';
    const slash = '#e63232';
    const r = Math.max(2, Math.floor(size * 0.2));

    // Rounded rect background
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = bg;
    roundRect(ctx, 0.5, 0.5, size - 1, size - 1, r);
    ctx.fill();

    // Letter G (simple strokes)
    ctx.strokeStyle = fg;
    ctx.fillStyle = fg;
    ctx.lineWidth = Math.max(1.5, size * 0.12);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const cx = size / 2;
    const cy = size / 2;
    const rad = size * 0.28;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0.35 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();
    // G crossbar
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + rad * 0.85, cy);
    ctx.stroke();
    // G lower lip
    ctx.beginPath();
    ctx.moveTo(cx + rad * 0.85, cy);
    ctx.lineTo(cx + rad * 0.85, cy + rad * 0.55);
    ctx.stroke();

    if (!on) {
      // Thick red ban slash
      ctx.strokeStyle = slash;
      ctx.lineWidth = Math.max(2.5, size * 0.16);
      ctx.beginPath();
      ctx.moveTo(size * 0.78, size * 0.2);
      ctx.lineTo(size * 0.22, size * 0.8);
      ctx.stroke();
    }

    return ctx.getImageData(0, 0, size, size);
  } catch {
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * @param {boolean} enabled
 * @param {typeof chrome.action} [actionApi]
 */
export async function paintActionBadge(enabled, actionApi = globalThis.chrome?.action) {
  if (!actionApi) return { ok: false, reason: 'no-action-api' };

  const on = isBadgeOn(enabled);
  const badge = on ? BADGE_ON : BADGE_OFF;

  // Clear per-tab badge text
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      (tabs || []).map((tab) =>
        tab.id != null
          ? actionApi.setBadgeText({ text: '', tabId: tab.id })
          : Promise.resolve(),
      ),
    );
  } catch {
    /* ignore */
  }

  let iconOk = false;

  // 1) ImageData icons (most reliable across Chromium forks)
  try {
    const imageData = {};
    for (const size of [16, 32]) {
      const id = drawStateIcon(size, on);
      if (id) imageData[size] = id;
    }
    if (Object.keys(imageData).length && actionApi.setIcon) {
      await actionApi.setIcon({ imageData });
      iconOk = true;
    }
  } catch {
    /* fall through to path */
  }

  // 2) Path-based backup
  if (!iconOk) {
    const pathDict = on ? ICON_PATHS_ON : ICON_PATHS_OFF;
    const attempts = [];
    if (chrome.runtime?.getURL) {
      const abs = {};
      for (const [k, v] of Object.entries(pathDict)) abs[k] = chrome.runtime.getURL(v);
      attempts.push({ path: abs });
      attempts.push({ path: chrome.runtime.getURL(pathDict[32]) });
    }
    attempts.push({ path: { ...pathDict } });
    attempts.push({ path: pathDict[32] });
    for (const arg of attempts) {
      try {
        await actionApi.setIcon(arg);
        iconOk = true;
        break;
      } catch {
        /* next */
      }
    }
  }

  try {
    await actionApi.setTitle({ title: badge.title });
  } catch {
    /* ignore */
  }

  try {
    await actionApi.setBadgeBackgroundColor({ color: badge.color });
    if (actionApi.setBadgeTextColor) {
      try {
        await actionApi.setBadgeTextColor({ color: '#ffffff' });
      } catch {
        /* ignore */
      }
    }
    await actionApi.setBadgeText({ text: on ? 'ON' : 'OFF' });
  } catch {
    /* ignore */
  }

  // Re-apply shortly after (Helium sometimes drops the first paint)
  setTimeout(() => {
    try {
      const imageData = {};
      for (const size of [16, 32]) {
        const id = drawStateIcon(size, on);
        if (id) imageData[size] = id;
      }
      if (Object.keys(imageData).length) {
        actionApi.setIcon?.({ imageData });
      }
      actionApi.setTitle?.({ title: badge.title });
      actionApi.setBadgeText?.({ text: on ? 'ON' : 'OFF' });
      actionApi.setBadgeBackgroundColor?.({ color: badge.color });
    } catch {
      /* ignore */
    }
  }, 120);

  return { ok: iconOk, on, text: badge.text, icon: on ? 'on' : 'off' };
}
