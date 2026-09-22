/**
 * Media freeze engine for GAF.
 * Evolved from the Helium stop-animations freeze-core with broader image formats
 * and policy-aware video handling (policy is decided by the caller).
 */

const ANIMATED_IMAGE_EXTENSIONS =
  /\.(?:gif|webp|avif|apng|png)(?:[?#].*)?$/i;
const LIKELY_STATIC_IMAGE = /\.(?:jpe?g|jfif|bmp|svg|ico)(?:[?#].*)?$/i;
const GIF_ONLY = /\.gif(?:[?#].*)?$/i;
const VIDEO_URL_EXTENSIONS = /\.(mp4|webm|m4v|mov|ogv)(?:[?#].*)?$/i;
const VIDEO_SOURCE_ATTRIBUTES = ['src', 'srcset', 'data-src', 'data-srcset'];
const VIDEO_ELEMENT_SOURCE_ATTRIBUTES = ['src', 'data-src', 'data-srcset'];

export function isLikelyAnimatedImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.startsWith('data:image/jpeg') || u.startsWith('data:image/jpg')) return false;
  if (u.startsWith('data:image/gif')) return true;
  if (u.startsWith('data:image/webp') || u.startsWith('data:image/avif') || u.startsWith('data:image/apng')) {
    // data URLs of these types *may* be animated; treat as candidates
    return true;
  }
  if (GIF_ONLY.test(u)) return true;
  // WebP/AVIF/APNG/PNG can be animated; still freeze only when extension matches
  // and we are not clearly a static JPEG/etc. Callers may further gate WebP.
  if (LIKELY_STATIC_IMAGE.test(u) && !GIF_ONLY.test(u)) return false;
  if (/\.gif(?:[?#].*)?$/i.test(u)) return true;
  // Conservative: only auto-freeze GIF by default for non-gif extensions unless option says so.
  // Broader formats are handled via isAnimatedImageUrl with options.
  return false;
}

/**
 * @param {string} url
 * @param {{ includeModern?: boolean }} [options]
 * includeModern: also treat .webp/.avif/.apng as freeze candidates (may over-freeze static WebP).
 */
export function isAnimatedImageUrl(url, options = {}) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  // data:image/gif is often a 1×1 lazy-load spacer — not a real animation to freeze
  if (u.startsWith('data:image/gif')) {
    return options.allowDataGif === true;
  }
  if (GIF_ONLY.test(u)) return true;
  if (options.includeModern) {
    if (u.startsWith('data:image/webp') || u.startsWith('data:image/avif') || u.startsWith('data:image/apng')) {
      return true;
    }
    // .webp/.avif — many static; only freeze when URL hints at animation
    if (/\.(webp|avif|apng)(?:[?#].*)?$/i.test(u)) {
      return /anim|gif|loop|motion|teaser|preview|spin|loader/i.test(u) || options.aggressiveModern === true;
    }
  }
  return false;
}

/**
 * Lazy-load spacers: tiny GIF / blank data-URI "images" that newspapers swap out later.
 * Freezing these hides the real photo forever behind a blank canvas (av-avis.no / Polaris).
 */
export function isLazyPlaceholderImage(img, url) {
  const u = (url || img?.currentSrc || img?.src || img?.getAttribute?.('src') || '').trim();
  if (!u) return true;

  // Classic 1×1 / spacer data GIFs
  if (u.startsWith('data:image/gif')) return true;
  if (u.startsWith('data:image/svg') && /viewBox=['"]0 0 1 1['"]/i.test(u)) return true;

  // Transparent pixel / very small natural size
  const nw = Number(img?.naturalWidth) || 0;
  const nh = Number(img?.naturalHeight) || 0;
  if (img?.complete && nw > 0 && nh > 0 && nw <= 32 && nh <= 32) {
    return true;
  }

  // Common lazy attrs still waiting for real URL
  if (
    (img?.getAttribute?.('data-src') || img?.getAttribute?.('data-lazy-src') || img?.getAttribute?.('data-original')) &&
    (u.startsWith('data:') || /placeholder|spacer|blank|lazy|pixel|transparent/i.test(u))
  ) {
    return true;
  }

  return false;
}

export function isVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return VIDEO_URL_EXTENSIONS.test(url.trim());
}

function rememberOriginalStyle(element, property) {
  const key = `gafOriginal${property[0].toUpperCase()}${property.slice(1)}`;
  if (element.dataset[key] === undefined) {
    element.dataset[key] = element.style[property] ?? '';
  }
}

function restoreOriginalStyle(element, property) {
  const key = `gafOriginal${property[0].toUpperCase()}${property.slice(1)}`;
  if (element.dataset[key] !== undefined) {
    element.style[property] = element.dataset[key];
    delete element.dataset[key];
  } else {
    element.style[property] = '';
  }
}

function copyVisualStyle(source, target) {
  target.className = source.className || '';
  target.setAttribute('aria-hidden', 'true');
  target.dataset.gafFreezeCanvas = 'true';
  target.style.display = source.style.display || '';
  target.style.width = source.style.width || (source.width ? `${source.width}px` : '');
  target.style.height = source.style.height || (source.height ? `${source.height}px` : '');
  target.style.maxWidth = source.style.maxWidth || '100%';
  target.style.objectFit = source.style.objectFit || 'cover';
  target.style.verticalAlign = source.style.verticalAlign || 'middle';
}

export function freezeAnimatedImageElement(img, options = {}) {
  if (!img || img.dataset?.gafIgnore === '1') return false;

  const url = img.currentSrc || img.src || img.getAttribute?.('src') || '';
  const includeModern = options.includeModern === true;
  const animOpts = { includeModern, aggressiveModern: options.aggressiveModern };

  // Already frozen: if the src has been swapped to a real static photo, unfreeze.
  if (img.dataset?.gafFrozen === 'image') {
    if (!isAnimatedImageUrl(url, animOpts) || isLazyPlaceholderImage(img, url)) {
      restoreImage(img);
      return false;
    }
    // Canvas swap inside a lightbox can break flex layout of the side panel
    if (isMediaInsideInteractiveChrome(img)) {
      restoreImage(img);
      return false;
    }
    return false;
  }

  // Leave lightbox / compose media alone (X photo viewer layout)
  if (isMediaInsideInteractiveChrome(img)) return false;

  if (isLazyPlaceholderImage(img, url)) return false;
  if (!isAnimatedImageUrl(url, animOpts)) return false;
  if (!img.parentNode) return false;
  if (img.complete === false || (img.naturalWidth === 0 && img.naturalHeight === 0)) return false;

  // Guard: never freeze sub-icon / spacer dimensions even if URL looks like .gif
  const nw = img.naturalWidth || 0;
  const nh = img.naturalHeight || 0;
  if (nw > 0 && nh > 0 && (nw <= 32 || nh <= 32)) return false;

  const doc = options.document || img.ownerDocument || globalThis.document;
  if (!doc?.createElement) return false;

  const width = img.naturalWidth || img.width || img.clientWidth || 1;
  const height = img.naturalHeight || img.height || img.clientHeight || 1;
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  copyVisualStyle(img, canvas);
  // Remember which URL we froze so we can detect lazy src swaps
  img.dataset.gafFrozenSrc = url.slice(0, 500);

  try {
    const context = canvas.getContext?.('2d');
    if (!context) return false;
    context.drawImage(img, 0, 0, width, height);
  } catch {
    canvas.remove?.();
    delete img.dataset.gafFrozenSrc;
    return false;
  }

  img.parentNode.insertBefore(canvas, img);
  rememberOriginalStyle(img, 'display');
  img.style.display = 'none';
  img.dataset.gafFrozen = 'image';
  img.dataset.gafCanvasInserted = 'true';
  return true;
}

/**
 * Unfreeze images whose URL is no longer a real animated GIF (lazy-load swap).
 * @returns {number} count restored
 */
export function reconcileFrozenImages(root = globalThis.document, options = {}) {
  if (!root?.querySelectorAll) return 0;
  let restored = 0;
  const includeModern = options.includeModern === true;
  // Use tag-only selector for broad compatibility (tests + shadow walks)
  for (const img of walkComposedElements(root, 'img')) {
    if (img.dataset?.gafFrozen !== 'image') continue;
    const url = img.currentSrc || img.src || img.getAttribute?.('src') || '';
    const frozenSrc = img.dataset?.gafFrozenSrc || '';
    const stillAnimated =
      isAnimatedImageUrl(url, { includeModern }) && !isLazyPlaceholderImage(img, url);
    const srcChanged = frozenSrc && url && frozenSrc !== url.slice(0, 500);
    if (!stillAnimated || srcChanged) {
      // If src changed to a new real GIF, restore then freeze again below
      restoreImage(img);
      restored += 1;
      if (stillAnimated && srcChanged && !isLazyPlaceholderImage(img, url)) {
        freezeAnimatedImageElement(img, options);
      }
    }
  }
  return restored;
}

function elementSourceAttribute(element) {
  return element.getAttribute?.('src') || element.getAttribute?.('data-src') || '';
}

function isCustomPreviewVideoElement(element) {
  if (!element?.tagName) return false;
  const tagName = element.tagName.toUpperCase();
  if (tagName === 'PREVIEW-VIDEO') return true;
  // VG / Schibsted also mark hosts with preview-video-* classes
  const cls = typeof element.className === 'string' ? element.className : '';
  if (/preview-video/i.test(cls) && tagName !== 'IMG' && tagName !== 'SOURCE') return true;
  if (['VIDEO', 'SOURCE', 'IMG', 'PICTURE', 'A', 'IFRAME', 'CANVAS', 'SVG'].includes(tagName)) {
    return false;
  }
  return tagName.includes('-') && (tagName.includes('VIDEO') || isVideoUrl(elementSourceAttribute(element)));
}

function previewElementSrc(element) {
  if (!element) return '';
  const attr = element.getAttribute?.('src') || element.getAttribute?.('data-src') || '';
  if (attr) return attr;
  try {
    if (typeof element.src === 'string' && element.src) return element.src;
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Kill in-screen teaser loops (VG &lt;preview-video&gt; etc.).
 * Re-runs if the site re-injects src / play classes after the first freeze.
 */
export function freezePreviewVideoElement(element) {
  if (!isCustomPreviewVideoElement(element)) return false;
  if (element.dataset?.gafIgnore === '1') return false;

  const srcNow = previewElementSrc(element);
  const already = element.dataset?.gafFrozen === 'preview-video';
  const hasPlayClass =
    typeof element.className === 'string' &&
    /preview-video-(in-screen|loaded)/i.test(element.className);
  // Still fully suppressed — nothing to do
  if (already && !srcNow && !hasPlayClass) {
    const display = element.style?.display;
    if (display === 'none') return false;
  }

  if (!already) {
    element.dataset.gafFrozen = 'preview-video';
    if (srcNow) element.dataset.gafOriginalPreviewSrc = srcNow.slice(0, 2000);
    element.dataset.gafOriginalPreviewDataSrc = element.getAttribute?.('data-src') ?? '';
    rememberOriginalStyle(element, 'display');
  } else if (srcNow && !element.dataset.gafOriginalPreviewSrc) {
    element.dataset.gafOriginalPreviewSrc = srcNow.slice(0, 2000);
  }

  // Strip light-DOM + property src (custom elements often bind .src)
  element.removeAttribute?.('src');
  element.removeAttribute?.('data-src');
  element.removeAttribute?.('data-video-src');
  element.removeAttribute?.('href');
  try {
    if ('src' in element) element.src = '';
  } catch {
    /* ignore */
  }

  // VG toggles these to fade the poster and start the loop
  try {
    if (element.classList) {
      element.classList.remove('preview-video-in-screen', 'preview-video-loaded');
    }
  } catch {
    /* ignore */
  }
  try {
    const cls = element.className;
    if (typeof cls === 'string' && /preview-video-(in-screen|loaded)/i.test(cls)) {
      element.className = cls
        .split(/\s+/)
        .filter((c) => c && !/preview-video-(in-screen|loaded)/i.test(c))
        .join(' ');
    }
  } catch {
    /* ignore */
  }

  // Pause any nested / shadow &lt;video&gt; the component created
  const roots = [element];
  if (element.shadowRoot) roots.push(element.shadowRoot);
  for (const root of roots) {
    let videos = [];
    try {
      videos = Array.from(root.querySelectorAll?.('video') || []);
    } catch {
      videos = [];
    }
    for (const video of videos) {
      try {
        video.pause?.();
      } catch {
        /* ignore */
      }
      try {
        video.removeAttribute?.('src');
        video.src = '';
        video.load?.();
      } catch {
        /* ignore */
      }
      try {
        video.style.setProperty('display', 'none', 'important');
      } catch {
        /* ignore */
      }
    }
  }

  try {
    element.style.setProperty('display', 'none', 'important');
    element.style.setProperty('visibility', 'hidden', 'important');
    element.style.setProperty('pointer-events', 'none', 'important');
    element.style.setProperty('opacity', '0', 'important');
  } catch {
    element.style.display = 'none';
  }
  return true;
}

/** CSS backup for news teaser loops (VG poster stays visible). */
export const PREVIEW_VIDEO_FREEZE_STYLE_ID = 'gaf-preview-video-style';
export const PREVIEW_VIDEO_FREEZE_CSS = `
/* GAF: freeze custom teaser loops (vg.no &lt;preview-video&gt;) */
preview-video {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
  width: 0 !important;
  height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
}
/* Keep sibling poster image when VG would fade it out */
preview-video + img,
.preview-video-loaded + img,
.preview-video-in-screen + img {
  opacity: 1 !important;
  visibility: visible !important;
}
`.trim();

export function applyPreviewVideoFreezeStyle(doc = globalThis.document) {
  if (!doc?.documentElement) return false;
  let el = doc.getElementById?.(PREVIEW_VIDEO_FREEZE_STYLE_ID);
  if (!el) {
    el = doc.createElement('style');
    el.id = PREVIEW_VIDEO_FREEZE_STYLE_ID;
    el.setAttribute('data-gaf', 'preview-video');
    (doc.head || doc.documentElement).appendChild(el);
  }
  if (el.textContent !== PREVIEW_VIDEO_FREEZE_CSS) el.textContent = PREVIEW_VIDEO_FREEZE_CSS;
  return true;
}

export function removePreviewVideoFreezeStyle(doc = globalThis.document) {
  doc?.getElementById?.(PREVIEW_VIDEO_FREEZE_STYLE_ID)?.remove?.();
}

function pauseVideo(video) {
  try {
    video.pause?.();
  } catch {
    /* ignore */
  }
  try {
    if (Number.isFinite(video.currentTime) && video.currentTime > 0.05) {
      video.currentTime = 0;
    }
  } catch {
    /* ignore */
  }
}

function videoSources(video) {
  return Array.from(video.querySelectorAll?.('source') || []);
}

function saveAttributes(element, attributes) {
  const saved = {};
  for (const attribute of attributes) {
    saved[attribute] = element.getAttribute?.(attribute) ?? '';
  }
  return saved;
}

function restoreAttributes(element, saved, attributes) {
  for (const attribute of attributes) {
    const value = saved?.[attribute] ?? '';
    if (value) element.setAttribute?.(attribute, value);
    else element.removeAttribute?.(attribute);
  }
}

function stripVideoSources(video) {
  if (video.dataset.gafSourcesStripped === 'true') return;

  const sources = videoSources(video).map((source, index) => ({
    index,
    attrs: saveAttributes(source, VIDEO_SOURCE_ATTRIBUTES),
  }));

  video.dataset.gafOriginalSrc = video.getAttribute?.('src') ?? video.src ?? '';
  video.dataset.gafOriginalVideoSourceAttrs = JSON.stringify(
    saveAttributes(video, VIDEO_ELEMENT_SOURCE_ATTRIBUTES)
  );
  video.dataset.gafOriginalSources = JSON.stringify(sources);

  for (const attribute of VIDEO_ELEMENT_SOURCE_ATTRIBUTES) {
    video.removeAttribute?.(attribute);
  }
  try {
    video.src = '';
  } catch {
    /* ignore */
  }
  for (const source of videoSources(video)) {
    for (const attribute of VIDEO_SOURCE_ATTRIBUTES) {
      source.removeAttribute?.(attribute);
    }
  }
  video.dataset.gafSourcesStripped = 'true';
  video.setAttribute?.('preload', 'none');
  try {
    video.load?.();
  } catch {
    /* ignore */
  }
}

/**
 * Heuristic: does this video look like an autoplay/looping thumbnail rather than a user player?
 */
export function looksLikeAutoplayThumbnail(video) {
  if (!video) return false;
  if (video.dataset?.gafUserPlay === '1') return false;
  if (video.controls && video.dataset?.gafFrozen !== 'video') {
    // Controllers with controls attribute are often intentional; still freeze if autoplay+muted+loop
    const aggressive =
      (video.autoplay || video.hasAttribute?.('autoplay')) &&
      (video.loop || video.hasAttribute?.('loop')) &&
      (video.muted || video.hasAttribute?.('muted'));
    if (!aggressive) return false;
  }

  return Boolean(
    video.autoplay ||
      video.loop ||
      video.muted ||
      video.hasAttribute?.('autoplay') ||
      video.hasAttribute?.('loop') ||
      video.getAttribute?.('playsinline') !== null ||
      video.getAttribute?.('muted') !== null ||
      video.getAttribute?.('poster') !== null ||
      video.getAttribute?.('src') ||
      video.getAttribute?.('data-src') ||
      video.src ||
      videoSources(video).some((source) =>
        VIDEO_SOURCE_ATTRIBUTES.some((attribute) => source.getAttribute?.(attribute))
      )
  );
}

/**
 * Stricter heuristic for global "heuristic" video policy — fewer false positives.
 */
export function looksLikeAutoplayThumbnailStrict(video) {
  if (!video || video.dataset?.gafUserPlay === '1') return false;
  const auto =
    video.autoplay ||
    video.hasAttribute?.('autoplay') ||
    video.getAttribute?.('data-autoplay') !== null;
  const loop = video.loop || video.hasAttribute?.('loop');
  const muted = video.muted || video.hasAttribute?.('muted');
  const playsInline = video.getAttribute?.('playsinline') !== null || video.playsInline;
  // Thumbnail-like if autoplay and (loop or muted playsinline)
  if (auto && (loop || (muted && playsInline))) return true;
  if (auto && muted && !video.controls) return true;
  if (loop && muted && !video.controls) return true;
  return false;
}

/**
 * Box used for layout-critical checks. Prefers the painted rect; falls back to
 * CSS/HTML width/height so we can decide before the first frame decodes.
 */
function elementBox(el) {
  if (!el) return { width: 0, height: 0 };
  try {
    const r = el.getBoundingClientRect?.();
    if (r && (r.width > 1 || r.height > 1)) {
      return { width: r.width, height: r.height };
    }
  } catch {
    /* ignore */
  }
  const width = Number(el.clientWidth) || Number(el.width) || 0;
  const height = Number(el.clientHeight) || Number(el.height) || 0;
  return { width, height };
}

/**
 * True if this video *is* the page (full-bleed marketing hero / background).
 * Stripping src on those leaves a transparent 100vh hole — white headline on
 * white body, which reads as a blank page (wayve.ai and similar product sites).
 * Pause + drop autoplay/loop still stops the annoyance; keep the file so the
 * first frame can paint.
 */
export function isLayoutCriticalVideo(video, view = globalThis) {
  if (!video) return false;
  const win = view?.defaultView || view;
  const iw = Number(view?.innerWidth || win?.innerWidth) || 0;
  const ih = Number(view?.innerHeight || win?.innerHeight) || 0;
  if (iw < 200 || ih < 200) return false;

  let { width, height } = elementBox(video);
  if (width < 2 || height < 2) {
    const parent = video.parentElement || video.parentNode;
    if (parent && parent !== video.ownerDocument?.body && parent !== video.ownerDocument?.documentElement) {
      const pb = elementBox(parent);
      width = pb.width;
      height = pb.height;
    }
  }
  return width >= iw * 0.5 && height >= ih * 0.4;
}

/**
 * True if video lives inside a lightbox / compose / modal chrome that must keep
 * working. Freezing+stripping sources there races SPA re-renders (X.com photo
 * viewer: stacked/garbled conversation column until full reload).
 */
export function isMediaInsideInteractiveChrome(el) {
  if (!el || typeof el.closest !== 'function') return false;
  try {
    return Boolean(
      el.closest(
        [
          '[role="dialog"]',
          'dialog',
          '[aria-modal="true"]',
          '[data-testid="mask"]',
          '[data-testid="twc-cc-mask"]',
          '[data-testid="sheetDialog"]',
          '[data-testid="videoPlayer"]',
          '[data-testid="videoComponent"]',
          '[data-testid="tweetTextarea_0"]',
          // X status photo/video path: /status/…/photo/1
          '[aria-labelledby][aria-modal="true"]',
        ].join(', '),
      ),
    );
  } catch {
    return false;
  }
}

export function freezeVideoElement(video, options = {}) {
  if (!video) return false;
  if (video.dataset?.gafIgnore === '1' || video.dataset?.gafUserPlay === '1') return false;
  // Never gut media inside open modals / photo viewers / compose
  if (isMediaInsideInteractiveChrome(video)) return false;

  const view = options.view || globalThis;
  const keepSource =
    video.dataset?.gafKeepSource === '1' || isLayoutCriticalVideo(video, view);

  const strict = options.strictHeuristic === true;
  const matcher = strict ? looksLikeAutoplayThumbnailStrict : looksLikeAutoplayThumbnail;

  if (video.dataset?.gafFrozen === 'video') {
    // If React moved a previously frozen video into a modal, restore it
    if (isMediaInsideInteractiveChrome(video)) {
      restoreVideo(video);
      return false;
    }
    pauseVideo(video);
    // Re-strip only feed thumbnails. Heroes must keep src on every pass or the
    // page JS will not be able to paint a still frame after we paused.
    if (!keepSource) stripVideoSources(video);
    return false;
  }

  if (!matcher(video)) return false;

  video.dataset.gafFrozen = 'video';
  video.dataset.gafOriginalAutoplay = String(
    Boolean(video.autoplay || video.hasAttribute?.('autoplay'))
  );
  video.dataset.gafOriginalLoop = String(Boolean(video.loop || video.hasAttribute?.('loop')));
  video.dataset.gafOriginalPreload = video.getAttribute?.('preload') ?? '';

  pauseVideo(video);
  try {
    video.autoplay = false;
    video.loop = false;
  } catch {
    /* ignore */
  }
  video.removeAttribute?.('autoplay');
  video.removeAttribute?.('loop');
  if (keepSource) {
    video.dataset.gafKeepSource = '1';
  } else {
    stripVideoSources(video);
  }
  return true;
}

/**
 * Walk open shadow roots under root (best-effort).
 */
export function* walkComposedElements(root, selector) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll(selector)) {
    yield el;
  }
  // Open shadow roots
  const all = root.querySelectorAll?.('*') || [];
  for (const host of all) {
    if (host.shadowRoot?.querySelectorAll) {
      yield* walkComposedElements(host.shadowRoot, selector);
    }
  }
}

export function freezeMediaIn(root = globalThis.document, options = {}) {
  if (!root?.querySelectorAll) return { images: 0, videos: 0, previews: 0, reconciled: 0 };

  const freezeImages = options.freezeImages !== false;
  const freezeVideos = options.freezeVideos === true;
  const includeModern = options.includeModern === true;
  const strictHeuristic = options.strictHeuristic === true;
  const doc = options.document || root.ownerDocument || root;

  let images = 0;
  let videos = 0;
  let previews = 0;
  let reconciled = 0;

  if (freezeImages) {
    // First undo bad freezes (placeholder → real photo) before freezing new GIFs
    reconciled = reconcileFrozenImages(root, { includeModern, document: doc });
    for (const img of walkComposedElements(root, 'img')) {
      if (freezeAnimatedImageElement(img, { document: doc, includeModern })) images += 1;
    }
  }

  if (freezeVideos) {
    applyPreviewVideoFreezeStyle(doc);
    // VG: <preview-video class="preview-video-loaded preview-video-in-screen" src="…mp4">
    // Also match akamaized teaser hosts and generic mp4/webm attrs.
    for (const preview of walkComposedElements(
      root,
      [
        'preview-video',
        '[class*="preview-video"]',
        '[src*=".mp4"]',
        '[src*=".webm"]',
        '[src*="akamaized"]',
        '[data-src*=".mp4"]',
        '[data-src*=".webm"]',
        '[data-src*="akamaized"]',
      ].join(', ')
    )) {
      if (freezePreviewVideoElement(preview)) previews += 1;
    }
    for (const video of walkComposedElements(root, 'video')) {
      if (freezeVideoElement(video, { strictHeuristic, view: options.view || globalThis })) {
        videos += 1;
      }
    }
  } else {
    removePreviewVideoFreezeStyle(doc);
  }

  return { images, videos, previews, reconciled };
}

function restoreImage(img) {
  let canvas = img.previousSibling;
  if (canvas?.dataset?.gafFreezeCanvas !== 'true' && img.parentNode?.children) {
    const siblings = Array.from(img.parentNode.children);
    const index = siblings.indexOf(img);
    canvas = index > 0 ? siblings[index - 1] : null;
  }
  if (canvas?.dataset?.gafFreezeCanvas === 'true') {
    canvas.remove();
  }
  restoreOriginalStyle(img, 'display');
  delete img.dataset.gafFrozen;
  delete img.dataset.gafCanvasInserted;
  delete img.dataset.gafFrozenSrc;
}

function restorePreviewVideo(element) {
  if (element.dataset.gafOriginalPreviewSrc) {
    element.setAttribute?.('src', element.dataset.gafOriginalPreviewSrc);
  } else {
    element.removeAttribute?.('src');
  }
  if (element.dataset.gafOriginalPreviewDataSrc) {
    element.setAttribute?.('data-src', element.dataset.gafOriginalPreviewDataSrc);
  } else {
    element.removeAttribute?.('data-src');
  }
  restoreOriginalStyle(element, 'display');
  delete element.dataset.gafFrozen;
  delete element.dataset.gafOriginalPreviewSrc;
  delete element.dataset.gafOriginalPreviewDataSrc;
}

function restoreVideoSources(video) {
  if (video.dataset.gafSourcesStripped !== 'true') return;

  if (video.dataset.gafOriginalSrc) {
    video.setAttribute?.('src', video.dataset.gafOriginalSrc);
    try {
      video.src = video.dataset.gafOriginalSrc;
    } catch {
      /* ignore */
    }
  } else {
    video.removeAttribute?.('src');
    try {
      video.src = '';
    } catch {
      /* ignore */
    }
  }

  let videoSourceAttrs = {};
  try {
    videoSourceAttrs = JSON.parse(video.dataset.gafOriginalVideoSourceAttrs || '{}');
  } catch {
    videoSourceAttrs = {};
  }
  restoreAttributes(
    video,
    videoSourceAttrs,
    VIDEO_ELEMENT_SOURCE_ATTRIBUTES.filter((attribute) => attribute !== 'src')
  );

  let sources = [];
  try {
    sources = JSON.parse(video.dataset.gafOriginalSources || '[]');
  } catch {
    sources = [];
  }
  const currentSources = videoSources(video);
  for (const saved of sources) {
    const source = currentSources[saved.index];
    if (!source) continue;
    if (saved.attrs) {
      restoreAttributes(source, saved.attrs, VIDEO_SOURCE_ATTRIBUTES);
    }
  }

  delete video.dataset.gafSourcesStripped;
  delete video.dataset.gafOriginalSrc;
  delete video.dataset.gafOriginalVideoSourceAttrs;
  delete video.dataset.gafOriginalSources;
  try {
    video.load?.();
  } catch {
    /* ignore */
  }
}

function restoreVideo(video) {
  restoreVideoSources(video);
  if (video.dataset.gafOriginalAutoplay === 'true') {
    video.autoplay = true;
    video.setAttribute?.('autoplay', '');
  }
  if (video.dataset.gafOriginalLoop === 'true') {
    video.loop = true;
    video.setAttribute?.('loop', '');
  }
  if (video.dataset.gafOriginalPreload) {
    video.setAttribute?.('preload', video.dataset.gafOriginalPreload);
  } else {
    video.removeAttribute?.('preload');
  }
  delete video.dataset.gafFrozen;
  delete video.dataset.gafOriginalAutoplay;
  delete video.dataset.gafOriginalLoop;
  delete video.dataset.gafOriginalPreload;
  delete video.dataset.gafKeepSource;
}

export function restoreFrozenMedia(elementsOrRoot = globalThis.document, options = {}) {
  let elements;
  if (Array.isArray(elementsOrRoot)) {
    elements = elementsOrRoot;
  } else if (elementsOrRoot?.querySelectorAll) {
    elements = Array.from(elementsOrRoot.querySelectorAll('[data-gaf-frozen]'));
    // open shadow roots
    for (const host of elementsOrRoot.querySelectorAll('*')) {
      if (host.shadowRoot) {
        elements.push(...host.shadowRoot.querySelectorAll('[data-gaf-frozen]'));
      }
    }
  } else {
    elements = [];
  }

  const allowedTypes = Array.isArray(options.types) ? new Set(options.types) : null;
  let changed = 0;
  for (const element of elements) {
    const frozenType = element.dataset?.gafFrozen;
    if (allowedTypes && !allowedTypes.has(frozenType)) continue;
    if (frozenType === 'image') {
      restoreImage(element);
      changed += 1;
    } else if (frozenType === 'preview-video') {
      restorePreviewVideo(element);
      changed += 1;
    } else if (frozenType === 'video') {
      restoreVideo(element);
      changed += 1;
    }
  }
  return changed;
}

/**
 * Custom player shell (Mixkit `.video-player`), not a hover-preview card.
 * Class selectors are tokens, so `item-grid-video-player` does not match.
 */
const PLAYER_SHELL_SELECTOR =
  '.video-player, [data-controller~="video-player--video-player"]';

function playerShellFor(element) {
  if (!element || typeof element.closest !== 'function') return null;
  try {
    return element.closest(PLAYER_SHELL_SELECTOR);
  } catch {
    return null;
  }
}

function isNavigationClick(target) {
  if (!target || typeof target.closest !== 'function') return false;
  let link = null;
  try {
    link = target.closest('a[href]');
  } catch {
    return false;
  }
  if (!link) return false;
  const href = link.getAttribute?.('href') || '';
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
  return true;
}

/**
 * Explicit play/pause control. Fullscreen, scrub, and volume controls are not.
 * Mixkit: button.video-player__play-pause[title="Toggle Play"] (sibling of the video).
 */
export function isPlaybackToggleControl(element) {
  if (!element || typeof element.closest !== 'function') return false;
  let control = null;
  try {
    control = element.closest(
      'button, [role="button"], [data-action*="togglePlay"], [data-action*="toggle-play"]'
    );
  } catch {
    return false;
  }
  if (!control) return false;
  const hint = [
    control.getAttribute?.('title'),
    control.getAttribute?.('aria-label'),
    control.getAttribute?.('data-action'),
    typeof control.className === 'string' ? control.className : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (/fullscreen|volume|\bmute\b|scrub|\bseek\b/i.test(hint) && !/toggleplay|play-pause|\b(play|pause)\b/i.test(hint)) {
    return false;
  }
  return /toggleplay|toggle-play|play-pause|play\/pause|\b(play|pause)\b/i.test(hint);
}

/**
 * Frozen video a click is trying to control.
 * Direct hits on the <video> count. So does a play/pause control in the same
 * player shell — closest('video') misses that button because it is a sibling.
 */
export function frozenVideoForUserGesture(target) {
  if (!target || typeof target.closest !== 'function') return null;
  let direct = null;
  try {
    direct = target.closest('video');
  } catch {
    direct = null;
  }
  if (direct?.dataset?.gafFrozen === 'video') return direct;
  if (isNavigationClick(target)) return null;
  if (!isPlaybackToggleControl(target)) return null;
  const shell = playerShellFor(target);
  const video = shell?.querySelector?.('video');
  if (video?.dataset?.gafFrozen === 'video') return video;
  return null;
}

/**
 * Stimulus-style players (Mixkit) set is-paused-value=false in connect()
 * because they assume muted autoplay already started. GAF has paused the
 * element, so the first toggle would call pause() again.
 */
export function playerAssumesAutoplayRunning(video) {
  const shell = playerShellFor(video);
  if (!shell || typeof shell.getAttributeNames !== 'function') return false;
  try {
    for (const name of shell.getAttributeNames()) {
      if (!/is-paused-value$/i.test(name)) continue;
      if (shell.getAttribute(name) === 'false') return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * True when the page's play/pause toggle would pause an already-paused frozen
 * video. Caller should start playback and skip that page handler so the
 * controller's "playing" flag stays in sync with the icon.
 */
export function shouldStartPlayOnFrozenToggle(target, video) {
  if (!video || video.dataset?.gafFrozen !== 'video') return false;
  if (video.paused === false) return false;
  if (isNavigationClick(target)) return false;
  if (!playerAssumesAutoplayRunning(video)) return false;
  let onVideo = false;
  try {
    onVideo = target?.closest?.('video') === video;
  } catch {
    onVideo = false;
  }
  if (onVideo) return true;
  return isPlaybackToggleControl(target);
}

/**
 * @returns {{ video: Element, startPlay: boolean } | null}
 */
export function resolveFrozenVideoGesture(target) {
  const video = frozenVideoForUserGesture(target);
  if (!video) return null;
  return {
    video,
    startPlay: shouldStartPlayOnFrozenToggle(target, video),
  };
}

/**
 * Mark a video as user-intent so GAF stops re-freezing it this session.
 */
export function allowVideoPlay(video) {
  if (!video) return;
  video.dataset.gafUserPlay = '1';
  if (video.dataset.gafFrozen === 'video') {
    restoreVideo(video);
  }
}
