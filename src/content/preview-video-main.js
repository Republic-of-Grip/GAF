/**
 * GAF preview-video kill — MAIN world, document_start.
 *
 * VG/Schibsted <preview-video> (RenderWebComponent):
 *   - open shadow root
 *   - IntersectionObserver → create muted/autoplay/loop <video>, copy host attrs
 *   - plays on intersect; re-renders if play() fails
 *
 * Isolated freeze (removeAttribute src + display:none) loses the race when:
 *   - master switch was off (badge OFF) so no CSS ran
 *   - or observer re-creates the shadow video after we strip
 *
 * Strategy: patch customElements.define before the page registers preview-video,
 * inject CSS, and continuously neuter any live instances.
 */
(() => {
  if (globalThis.__gafPreviewVideoMain) return;
  globalThis.__gafPreviewVideoMain = true;

  /**
   * When false, leave preview-video alone (master off / video policy off / excluded).
   * Start false until early.js posts config.
   *
   * OFF/excluded invariant: do not permanently replace the page's custom-element
   * constructor while kill is off. customElements.define is irreversible for the
   * document lifetime — optimistic kill+dead-define violated that when GAF was OFF.
   *
   * Trade-off: if the page defines preview-video before kill config arrives, the
   * original constructor registers and we fall back to CSS + neuter loop (still
   * effective on VG). Toggle OFF after a dead define cannot restore the original
   * constructor (documented CE platform limit).
   */
  let killEnabled = false;
  /** True once we substituted GafDeadPreviewVideo for the page constructor. */
  let deadDefined = false;

  const STYLE_ID = 'gaf-preview-video-main-style';
  const CSS = `
preview-video {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
  width: 0 !important;
  height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
  position: absolute !important;
}
preview-video + img,
.preview-video-loaded + img,
.preview-video-in-screen + img {
  opacity: 1 !important;
  visibility: visible !important;
}
`.trim();

  function injectCss() {
    if (!killEnabled) {
      document.getElementById(STYLE_ID)?.remove();
      return;
    }
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      el.setAttribute('data-gaf', 'preview-video-main');
      (document.documentElement || document.head || document).appendChild(el);
    }
    if (el.textContent !== CSS) el.textContent = CSS;
  }

  function neuterEl(el) {
    if (!el || el.tagName !== 'PREVIEW-VIDEO') return;
    try {
      el.removeAttribute('src');
      el.removeAttribute('data-src');
      el.removeAttribute('autoplay');
      el.removeAttribute('loop');
      try {
        if ('src' in el) el.src = '';
      } catch {
        /* ignore */
      }
      try {
        el.classList?.remove?.('preview-video-in-screen', 'preview-video-loaded');
      } catch {
        /* ignore */
      }
      // Disconnect IntersectionObserver if component stashed it
      try {
        el.observer?.disconnect?.();
      } catch {
        /* ignore */
      }
      const root = el.shadowRoot;
      if (root) {
        for (const v of root.querySelectorAll('video')) {
          try {
            v.pause?.();
          } catch {
            /* ignore */
          }
          try {
            v.removeAttribute('src');
            v.src = '';
            v.load?.();
          } catch {
            /* ignore */
          }
        }
        try {
          root.innerHTML = '';
        } catch {
          /* ignore */
        }
      }
      try {
        el.style.setProperty('display', 'none', 'important');
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }

  function neuterAll() {
    if (!killEnabled) return;
    injectCss();
    try {
      document.querySelectorAll('preview-video').forEach(neuterEl);
    } catch {
      /* ignore */
    }
  }

  // --- Patch customElements.define before VG registers preview-video ---
  // Only substitute the dead class when kill is already enabled. Otherwise pass
  // the site constructor through so OFF/excluded pages keep native behaviour.
  try {
    const ce = customElements;
    const nativeDefine = ce.define.bind(ce);
    ce.define = function gafDefine(name, ctor, options) {
      if (name === 'preview-video') {
        if (!killEnabled) {
          // GAF inert — register the site's constructor unchanged
          return nativeDefine(name, ctor, options);
        }
        class GafDeadPreviewVideo extends HTMLElement {
          static get observedAttributes() {
            return ['src', 'data-src'];
          }
          constructor() {
            super();
            try {
              this.attachShadow({ mode: 'open' });
            } catch {
              /* already attached */
            }
          }
          connectedCallback() {
            if (!killEnabled) return;
            neuterEl(this);
          }
          attributeChangedCallback() {
            if (!killEnabled) return;
            neuterEl(this);
          }
          // Block common play entrypoints if site calls them
          play() {
            return Promise.resolve();
          }
        }
        try {
          const ret = nativeDefine(name, GafDeadPreviewVideo, options);
          deadDefined = true;
          return ret;
        } catch (err) {
          // Already defined — fall through to neuter loop
          console.info('[GAF] preview-video already defined, using neuter loop', err?.message);
          return undefined;
        }
      }
      return nativeDefine(name, ctor, options);
    };
  } catch {
    /* ignore */
  }

  function applyKillConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.killPreviewVideo === 'boolean') {
      killEnabled = cfg.killPreviewVideo;
    } else if (typeof cfg.enabled === 'boolean' && cfg.videoPolicy === 'off') {
      killEnabled = false;
    } else if (typeof cfg.enabled === 'boolean') {
      killEnabled = cfg.enabled;
    }
    if (killEnabled) {
      injectCss();
      neuterAll();
    } else {
      document.getElementById(STYLE_ID)?.remove();
      // Note: if deadDefined, original constructor cannot be restored (CE limit).
    }
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'gaf-extension') return;
      if (data.type === 'GAF_PREVIEW_VIDEO_CONFIG' || data.type === 'GAF_TIME_FREEZE_CONFIG') {
        // TIME_FREEZE message also carries master flags from early.js when extended
        if (data.type === 'GAF_PREVIEW_VIDEO_CONFIG') applyKillConfig(data);
        if (data.type === 'GAF_TIME_FREEZE_CONFIG' && 'killPreviewVideo' in data) {
          applyKillConfig(data);
        }
      }
    },
    false
  );

  // Do not optimistically enable kill — wait for early.js config so OFF/excluded
  // hosts never permanently alter customElements.define for preview-video.
  // When kill becomes true, CSS + neuter cover first paint / late defines.

  const boot = () => {
    neuterAll();
  };
  if (document.documentElement) boot();
  document.addEventListener('DOMContentLoaded', boot, { once: true });

  // Keep killing SPA re-mounts / late intersections that recreate shadow video
  setInterval(neuterAll, 400);

  try {
    const mo = new MutationObserver(() => {
      if (!killEnabled) return;
      neuterAll();
    });
    const start = () => {
      if (!document.documentElement) return;
      mo.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch {
    /* ignore */
  }
})();
