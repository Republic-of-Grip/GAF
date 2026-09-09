/**
 * Inspection archive — right-click "save object" records for later debugging.
 * Stored in chrome.storage.local (can be larger than sync).
 */

import { normalizeHost } from './settings.mjs';

export const MAX_ARCHIVE_ENTRIES = 200;
export const MAX_HTML_CHARS = 12000;
export const MAX_OUTER_CHARS = 8000;

/**
 * @typedef {object} ArchiveEntry
 * @property {string} id
 * @property {string} createdAt
 * @property {string} pageUrl
 * @property {string} pageTitle
 * @property {string} host
 * @property {string} tagName
 * @property {string} selectorHint
 * @property {string} idAttr
 * @property {string} className
 * @property {string} outerHtml
 * @property {string} textSample
 * @property {object} attributes
 * @property {object} hints  why this may have escaped filters
 * @property {string} [note]
 */

export function cssEscapeIdent(value) {
  return String(value || '').replace(/([^\w-])/g, '\\$1');
}

/**
 * Build a short selector path for human inspection.
 */
export function selectorHintFor(el) {
  if (!el || !el.tagName) return '';
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.tagName && depth < 6) {
    // Element nodes are nodeType 1; allow plain objects in tests without nodeType
    if (node.nodeType != null && node.nodeType !== 1) break;
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += `#${cssEscapeIdent(node.id)}`;
      parts.unshift(part);
      break;
    }
    const cls = String(node.className || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (cls.length) part += '.' + cls.map(cssEscapeIdent).join('.');
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

/**
 * Heuristic hints: why this element may have escaped GAF filters.
 */
export function buildEscapeHints(el, pageUrl = '') {
  const hints = [];
  if (!el) {
    hints.push({ code: 'no-element', message: 'No element reference' });
    return hints;
  }

  const tag = (el.tagName || '').toUpperCase();
  const src =
    el.currentSrc ||
    el.src ||
    el.getAttribute?.('src') ||
    el.getAttribute?.('data-src') ||
    '';
  const cls = String(el.className || '');
  const id = String(el.id || '');

  if (el.dataset?.gafFrozen) {
    hints.push({
      code: 'already-frozen',
      message: `GAF already marked this as frozen (${el.dataset.gafFrozen})`,
    });
  }

  if (tag === 'IMG') {
    if (!/\.gif(?:[?#].*)?$/i.test(src) && !String(src).startsWith('data:image/gif')) {
      hints.push({
        code: 'img-not-gif-url',
        message: 'Image URL does not look like a GIF — freeze-images only targets GIF (and optional modern animated formats).',
        detail: src.slice(0, 200),
      });
    }
    let pageOrigin = '';
    try {
      pageOrigin = globalThis.location?.origin || '';
    } catch {
      pageOrigin = '';
    }
    if (src && !src.startsWith('data:') && pageOrigin && !src.startsWith(pageOrigin)) {
      hints.push({
        code: 'cross-origin-img',
        message: 'Cross-origin image — canvas snapshot often fails (tainted canvas), so animation may continue.',
        detail: src.slice(0, 200),
      });
    } else if (src && !src.startsWith('data:') && /^https?:\/\//i.test(src)) {
      // No page origin available (e.g. unit tests) — still note remote URL risk
      hints.push({
        code: 'remote-img-url',
        message: 'Remote image URL — if cross-origin, canvas freeze may fail.',
        detail: src.slice(0, 200),
      });
    }
    if (el.complete === false || (el.naturalWidth === 0 && el.naturalHeight === 0)) {
      hints.push({
        code: 'img-not-loaded',
        message: 'Image not fully loaded when inspected — freeze may have skipped it.',
      });
    }
  }

  if (tag === 'VIDEO') {
    hints.push({
      code: 'video-policy',
      message:
        'Video freeze depends on video policy (off/news/heuristic), player-URL exclusions, and autoplay heuristics.',
    });
    if (el.dataset?.gafUserPlay === '1') {
      hints.push({ code: 'user-play', message: 'Marked as user-play — GAF will not re-freeze this video.' });
    }
    if (el.controls && !el.autoplay) {
      hints.push({
        code: 'controls-no-autoplay',
        message: 'Has controls and no autoplay — strict heuristic may leave it alone.',
      });
    }
  }

  if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') {
    hints.push({
      code: 'embedded-frame',
      message: 'Embedded frame/object — cross-origin content is outside this page’s DOM filters.',
      detail: el.getAttribute?.('src') || '',
    });
  }

  if (tag.includes('-') || el.shadowRoot) {
    hints.push({
      code: 'custom-or-shadow',
      message: 'Custom element and/or shadow DOM — closed shadow roots are invisible to GAF; open roots are only partially walked.',
    });
  }

  if (/anim|lottie|canvas|marquee|carousel|slider|parallax/i.test(cls + id)) {
    hints.push({
      code: 'scripted-motion-class',
      message: 'Class/id suggests scripted or canvas motion — CSS freeze may not stop JS-driven loops.',
    });
  }

  if (el.getAnimations) {
    try {
      const anims = el.getAnimations?.() || [];
      if (anims.length) {
        hints.push({
          code: 'waapi-animations',
          message: `${anims.length} Web Animation(s) on element — scripted-motion pause should catch these if enabled.`,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const style = el.style || {};
  if (style.animation || style.animationName || el.getAttribute?.('style')?.includes('animation')) {
    hints.push({
      code: 'inline-animation',
      message: 'Inline animation styles present — check CSS motion level (moderate vs strict).',
    });
  }

  // Background image GIFs
  try {
    const bg = globalThis.getComputedStyle?.(el)?.backgroundImage || '';
    if (/url\(/i.test(bg) && /\.gif/i.test(bg)) {
      hints.push({
        code: 'css-background-gif',
        message: 'Animated GIF may be a CSS background-image — not handled by <img> freeze.',
        detail: bg.slice(0, 200),
      });
    }
  } catch {
    /* ignore */
  }

  if (pageUrl) {
    hints.push({
      code: 'page-url',
      message: 'Page context for policy checks',
      detail: pageUrl.slice(0, 300),
    });
  }

  if (hints.length === 0) {
    hints.push({
      code: 'unknown',
      message: 'No specific escape heuristic matched — inspect HTML and site scripts manually.',
    });
  }

  return hints;
}

export function serializeElement(el, pageUrl, pageTitle) {
  if (!el) return null;

  const attrs = {};
  try {
    if (el.attributes) {
      for (const a of Array.from(el.attributes)) {
        attrs[a.name] = String(a.value).slice(0, 500);
      }
    }
  } catch {
    /* ignore */
  }

  let outerHtml = '';
  try {
    outerHtml = String(el.outerHTML || '').slice(0, MAX_OUTER_CHARS);
  } catch {
    outerHtml = '';
  }

  let textSample = '';
  try {
    textSample = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  } catch {
    textSample = '';
  }

  let host = '';
  try {
    host = normalizeHost(new URL(pageUrl).hostname);
  } catch {
    host = '';
  }

  return {
    id: `arc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    pageUrl: String(pageUrl || ''),
    pageTitle: String(pageTitle || ''),
    host,
    tagName: String(el.tagName || '').toLowerCase(),
    selectorHint: selectorHintFor(el),
    idAttr: String(el.id || ''),
    className: String(el.className || '').slice(0, 300),
    outerHtml,
    textSample,
    attributes: attrs,
    hints: buildEscapeHints(el, pageUrl),
    note: '',
  };
}

export function normalizeArchiveEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hideRuleAdded =
    raw.hideRuleAdded && typeof raw.hideRuleAdded === 'object'
      ? {
          selector: String(raw.hideRuleAdded.selector || ''),
          scope: raw.hideRuleAdded.scope === 'host' ? 'host' : 'global',
          host: normalizeHost(raw.hideRuleAdded.host || ''),
          at: String(raw.hideRuleAdded.at || ''),
        }
      : null;
  return {
    id: String(raw.id || `arc_${Date.now().toString(36)}`),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    pageUrl: String(raw.pageUrl || ''),
    pageTitle: String(raw.pageTitle || ''),
    host: normalizeHost(raw.host || ''),
    tagName: String(raw.tagName || ''),
    selectorHint: String(raw.selectorHint || ''),
    idAttr: String(raw.idAttr || ''),
    className: String(raw.className || ''),
    outerHtml: String(raw.outerHtml || '').slice(0, MAX_OUTER_CHARS),
    textSample: String(raw.textSample || ''),
    attributes: raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {},
    hints: Array.isArray(raw.hints) ? raw.hints : [],
    note: String(raw.note || ''),
    hideRuleAdded,
  };
}

export function normalizeArchive(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeArchiveEntry).filter(Boolean).slice(0, MAX_ARCHIVE_ENTRIES);
}

export function prependArchive(list, entry) {
  const e = normalizeArchiveEntry(entry);
  if (!e) return normalizeArchive(list);
  return [e, ...normalizeArchive(list)].slice(0, MAX_ARCHIVE_ENTRIES);
}
