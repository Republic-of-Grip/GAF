/**
 * Element-hiding engine — inject CSS rules that hide annoyances.
 */

export const HIDE_STYLE_ID = 'gaf-element-hide-style';

/**
 * Build a stylesheet body from selector list.
 * Invalid selectors are skipped at apply time by the browser; we still filter empties.
 */
export function buildHideCss(selectors) {
  const rules = (selectors || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((sel) => {
      // Avoid breaking out of CSS with unescaped braces in user input (best-effort)
      const safe = sel.replace(/[{}]/g, '');
      return `${safe}{display:none!important;visibility:hidden!important;pointer-events:none!important;}`;
    });
  if (!rules.length) return '';
  return `/* GAF element hide */\n${rules.join('\n')}`;
}

export function applyHideStyle(doc, selectors) {
  if (!doc?.documentElement) return false;
  const css = buildHideCss(selectors);
  let el = doc.getElementById?.(HIDE_STYLE_ID);

  if (!css) {
    el?.remove?.();
    return false;
  }

  if (!el) {
    el = doc.createElement('style');
    el.id = HIDE_STYLE_ID;
    el.setAttribute('data-gaf', 'element-hide');
    (doc.head || doc.documentElement).appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
  return true;
}

export function removeHideStyle(doc) {
  doc?.getElementById?.(HIDE_STYLE_ID)?.remove?.();
}
