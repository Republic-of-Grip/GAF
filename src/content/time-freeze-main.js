/**
 * GAF time freeze — MAIN world (page context).
 * Stretches long setTimeout / setInterval delays (soft-paywall meters).
 * Short delays are left alone so lazy-load and hydration keep working.
 */
(() => {
  if (globalThis.__gafTimeFreezeInstalled) return;
  globalThis.__gafTimeFreezeInstalled = true;

  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);

  let enabled = false;
  let factor = 80;
  let mode = 'off';
  let minMs = 2000;

  function stretchDelay(delay) {
    const d = Number(delay);
    if (!Number.isFinite(d) || d <= 0) return delay;
    // Critical: do not stretch short timers — newspapers use them for lazy images,
    // intersection fallbacks, React scheduling, etc. (see av-avis.no blank lower half).
    if (d < minMs) return d;
    if (mode === 'stop') {
      return Math.min(Math.max(d * Math.max(factor, 200), 3_600_000), 86_400_000);
    }
    return Math.min(d * factor, 86_400_000);
  }

  window.setTimeout = function gafSetTimeout(fn, delay, ...args) {
    if (!enabled) return nativeSetTimeout(fn, delay, ...args);
    return nativeSetTimeout(fn, stretchDelay(delay), ...args);
  };

  window.setInterval = function gafSetInterval(fn, delay, ...args) {
    if (!enabled) return nativeSetInterval(fn, delay, ...args);
    return nativeSetInterval(fn, stretchDelay(delay), ...args);
  };

  window.clearTimeout = nativeClearTimeout;
  window.clearInterval = nativeClearInterval;

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    mode = cfg.mode || 'off';
    factor = Number(cfg.factor) > 1 ? Number(cfg.factor) : 80;
    const m = Number(cfg.minMs);
    minMs = Number.isFinite(m) ? Math.max(0, m) : 2000;
    enabled = Boolean(cfg.enabled) && (mode === 'slow' || mode === 'stop');
  }

  function pageClick(selector) {
    if (!selector || typeof selector !== 'string') return false;
    try {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.click();
      return true;
    } catch {
      return false;
    }
  }

  function pageClickByText(reSource, reFlags) {
    try {
      const re = new RegExp(reSource, reFlags || 'i');
      const nodes = document.querySelectorAll(
        'button, [role="button"], a.button, input[type="button"], input[type="submit"]',
      );
      for (const el of nodes) {
        const t = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
        if (re.test(t)) {
          el.click();
          return t;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'gaf-extension') return;
      if (data.type === 'GAF_TIME_FREEZE_CONFIG') {
        applyConfig(data);
      }
      // Isolated-world content scripts click Alpine @click unreliably on some hosts;
      // run the real click in page (MAIN) context.
      if (data.type === 'GAF_PAGE_CLICK' && data.selector) {
        pageClick(data.selector);
      }
      if (data.type === 'GAF_PAGE_CLICK_TEXT' && data.re) {
        pageClickByText(data.re, data.flags || 'i');
      }
    },
    false
  );

  window.addEventListener(
    'gaf-time-freeze-config',
    (event) => {
      applyConfig(event.detail);
    },
    false
  );
})();
