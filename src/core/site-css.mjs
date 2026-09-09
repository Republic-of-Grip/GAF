/**
 * Per-host custom CSS injection.
 */

import { normalizeHost } from './settings.mjs';

export const SITE_CSS_ID = 'gaf-site-css-style';

export function cssForHost(siteCssMap, host) {
  if (!siteCssMap || typeof siteCssMap !== 'object') return '';
  const h = normalizeHost(host);
  if (!h) return '';
  // Exact then parent domain walk
  if (typeof siteCssMap[h] === 'string' && siteCssMap[h].trim()) {
    return siteCssMap[h];
  }
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (typeof siteCssMap[parent] === 'string' && siteCssMap[parent].trim()) {
      return siteCssMap[parent];
    }
  }
  return '';
}

export function applySiteCss(doc, css) {
  if (!doc?.documentElement) return false;
  const body = String(css || '').trim();
  let el = doc.getElementById?.(SITE_CSS_ID);
  if (!body) {
    el?.remove?.();
    return false;
  }
  if (!el) {
    el = doc.createElement('style');
    el.id = SITE_CSS_ID;
    el.setAttribute('data-gaf', 'site-css');
    (doc.head || doc.documentElement).appendChild(el);
  }
  if (el.textContent !== body) el.textContent = body;
  return true;
}

export function removeSiteCss(doc) {
  doc?.getElementById?.(SITE_CSS_ID)?.remove?.();
}
