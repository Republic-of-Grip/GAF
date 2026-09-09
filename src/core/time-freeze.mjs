/**
 * Time freeze — reading snapshot + UI bar.
 * Timer stretch runs in MAIN world (time-freeze-main.js); this module handles
 * the isolated-world snapshot overlay and control surface.
 */

export const FREEZE_UI_ID = 'gaf-time-freeze-ui';
export const FREEZE_FRAME_ID = 'gaf-time-freeze-frame';
export const FREEZE_HOST_ID = 'gaf-time-freeze-host';

export function buildSnapshotHtml(doc) {
  if (!doc?.documentElement) return '';
  try {
    const clone = doc.documentElement.cloneNode(true);
    // Remove scripts and GAF chrome from snapshot
    clone.querySelectorAll?.('script, noscript').forEach((n) => n.remove());
    clone.querySelectorAll?.(`#${FREEZE_UI_ID}, #${FREEZE_HOST_ID}, #${FREEZE_FRAME_ID}`).forEach((n) =>
      n.remove()
    );
    clone.querySelectorAll?.('[data-gaf]').forEach((n) => {
      if (n.tagName === 'STYLE') {
        // keep styles
      }
    });
    // Base tag for relative URLs
    let base = clone.querySelector?.('base');
    if (!base) {
      base = doc.createElement('base');
      base.setAttribute('href', doc.baseURI || doc.location?.href || '');
      clone.querySelector?.('head')?.insertBefore(base, clone.querySelector('head')?.firstChild || null);
    }
    return `<!DOCTYPE html>${clone.outerHTML}`;
  } catch {
    return '';
  }
}

export function isFreezeActive(doc) {
  return Boolean(doc?.getElementById?.(FREEZE_HOST_ID));
}

/**
 * Show reading snapshot overlay. Links open in top window; Thaw removes overlay.
 */
export function applyReadingSnapshot(doc, options = {}) {
  if (!doc?.documentElement || isFreezeActive(doc)) return false;
  const html = options.html || buildSnapshotHtml(doc);
  if (!html || html.length < 200) return false;

  const host = doc.createElement('div');
  host.id = FREEZE_HOST_ID;
  host.setAttribute('data-gaf', 'time-freeze');
  host.style.cssText = [
    'all:initial',
    'position:fixed',
    'inset:0',
    'z-index:2147483646',
    'display:flex',
    'flex-direction:column',
    'background:#0c1015',
    'font-family:system-ui,Segoe UI,sans-serif',
  ].join(';');

  const bar = doc.createElement('div');
  bar.id = FREEZE_UI_ID;
  bar.style.cssText = [
    'flex:0 0 auto',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'flex-wrap:wrap',
    'padding:8px 12px',
    'background:#151c24',
    'color:#e8eef6',
    'border-bottom:1px solid #2a3544',
    'font-size:13px',
    'line-height:1.3',
  ].join(';');

  const label = doc.createElement('span');
  label.textContent = 'GAF time freeze — reading snapshot (soft-paywall shield)';
  label.style.flex = '1 1 auto';
  label.style.fontWeight = '600';

  const thawBtn = doc.createElement('button');
  thawBtn.type = 'button';
  thawBtn.textContent = 'Thaw (live page)';
  thawBtn.style.cssText =
    'cursor:pointer;border:1px solid #3dd68c;background:#1a6b3c;color:#eafff3;border-radius:8px;padding:6px 10px;font:inherit;font-weight:600;';

  const hideBtn = doc.createElement('button');
  hideBtn.type = 'button';
  hideBtn.textContent = 'Hide bar';
  hideBtn.style.cssText =
    'cursor:pointer;border:1px solid #2a3544;background:transparent;color:#8b9bb0;border-radius:8px;padding:6px 10px;font:inherit;';

  bar.appendChild(label);
  bar.appendChild(hideBtn);
  bar.appendChild(thawBtn);

  const frame = doc.createElement('iframe');
  frame.id = FREEZE_FRAME_ID;
  frame.setAttribute('title', 'GAF reading snapshot');
  frame.style.cssText = 'flex:1 1 auto;width:100%;border:0;background:#fff;';
  // sandbox: allow same-origin for srcdoc scripts stripped already; allow-popups-to-escape for links
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
  frame.srcdoc = html;

  host.appendChild(bar);
  host.appendChild(frame);

  thawBtn.addEventListener('click', () => {
    removeReadingSnapshot(doc);
    options.onThaw?.();
  });
  hideBtn.addEventListener('click', () => {
    bar.style.display = 'none';
  });

  // Intercept link clicks inside iframe when possible
  frame.addEventListener('load', () => {
    try {
      const idoc = frame.contentDocument;
      if (!idoc) return;
      idoc.addEventListener(
        'click',
        (ev) => {
          const a = ev.target?.closest?.('a[href]');
          if (!a) return;
          const href = a.href;
          if (!href || href.startsWith('javascript:')) return;
          // Allow navigation in top window
          ev.preventDefault();
          removeReadingSnapshot(doc);
          options.onNavigate?.(href);
          try {
            globalThis.top.location.href = href;
          } catch {
            globalThis.location.href = href;
          }
        },
        true
      );
    } catch {
      // cross-origin should not happen with srcdoc
    }
  });

  (doc.documentElement || doc.body).appendChild(host);
  return true;
}

export function removeReadingSnapshot(doc) {
  doc?.getElementById?.(FREEZE_HOST_ID)?.remove?.();
}

/**
 * Message payload for MAIN-world timer control.
 * @param {object} settings
 * @param {{ enabled?: boolean }} [override] force enabled (caller already applied page policy)
 */
export function timeFreezeMainConfig(settings, override = {}) {
  const mode = settings?.timeFreezeMode || 'off';
  const factor = Number(settings?.timeFreezeSlowFactor) || 80;
  const minMs = Number(settings?.timeFreezeMinMs);
  const enabled =
    override.enabled !== undefined
      ? Boolean(override.enabled)
      : mode === 'slow' || mode === 'stop';
  return {
    type: 'GAF_TIME_FREEZE_CONFIG',
    mode: enabled ? mode : 'off',
    factor: mode === 'stop' ? Math.max(factor, 200) : factor,
    minMs: Number.isFinite(minMs) ? minMs : 2000,
    enabled,
  };
}

/**
 * Pure helper: should this timer delay be stretched?
 * Short delays power lazy-load / hydration; long ones are paywall-like.
 */
export function shouldStretchTimerDelay(delay, minMs = 2000) {
  const d = Number(delay);
  if (!Number.isFinite(d) || d <= 0) return false;
  const floor = Number.isFinite(Number(minMs)) ? Number(minMs) : 2000;
  return d >= floor;
}

export function computeStretchedDelay(delay, { mode = 'slow', factor = 80, minMs = 2000 } = {}) {
  const d = Number(delay);
  if (!Number.isFinite(d) || d <= 0) return delay;
  if (!shouldStretchTimerDelay(d, minMs)) return d;
  const f = Number(factor) > 1 ? Number(factor) : 80;
  if (mode === 'stop') {
    return Math.min(Math.max(d * Math.max(f, 200), 3_600_000), 86_400_000);
  }
  return Math.min(d * f, 86_400_000);
}
