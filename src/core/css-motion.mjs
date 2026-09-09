/**
 * CSS motion-kill styles for GAF.
 * Injected as early as possible (document_start) to reduce flash of animation.
 *
 * IMPORTANT: Moderate mode must NOT force animation-duration ≈ 0 or pause
 * all animations. News sites (e.g. Polaris / av-avis.no) fade lazy images in
 * with short CSS/WAAPI animations; killing those leaves solid colour placeholders.
 */

export const STYLE_ELEMENT_ID = 'gaf-motion-style';

/**
 * Interactive chrome (Alpine/Hyvä modals, cookie, filter sheets, cart drawers).
 * Undo motion-kill of enter/leave *animations/transitions* so dialogs are not
 * stalled mid-fade (ditur.no grey scrim). Do NOT force opacity / visibility /
 * transform / pointer-events: this stylesheet is unlayered, so revert-layer
 * equals revert → UA visible defaults. POWER.no Angular dialog shells stay
 * display:block when closed and hide with those properties; forcing UA defaults
 * paints empty white rectangles over the page (tilbudsfest, 2026-08).
 * Keep in sync with early.js.
 */
export const INTERACTIVE_UI_PROTECT_CSS = `
html.gaf-motion-active dialog,
html.gaf-motion-active dialog *,
html.gaf-motion-active dialog *::before,
html.gaf-motion-active dialog *::after,
html.gaf-motion-active [role="dialog"],
html.gaf-motion-active [role="dialog"] *,
html.gaf-motion-active [role="dialog"] *::before,
html.gaf-motion-active [role="dialog"] *::after,
html.gaf-motion-active [role="overlay"],
html.gaf-motion-active [role="overlay"] *,
html.gaf-motion-active [role="overlay"] *::before,
html.gaf-motion-active [role="overlay"] *::after,
html.gaf-motion-active [aria-modal="true"],
html.gaf-motion-active [aria-modal="true"] *,
html.gaf-motion-active [aria-modal="true"] *::before,
html.gaf-motion-active [aria-modal="true"] *::after,
html.gaf-motion-active .backdrop,
html.gaf-motion-active .backdrop *,
html.gaf-motion-active #nav-backdrop,
html.gaf-motion-active #nav-backdrop *,
html.gaf-motion-active [id$="-backdrop"],
html.gaf-motion-active [id$="-backdrop"] *,
html.gaf-motion-active .bg-image-overlay,
html.gaf-motion-active .bg-image-overlay *,
html.gaf-motion-active #cookie-banner,
html.gaf-motion-active #cookie-banner *,
html.gaf-motion-active #cookie-form,
html.gaf-motion-active #cookie-form *,
html.gaf-motion-active #cookie-popup,
html.gaf-motion-active #cookie-popup *,
html.gaf-motion-active #authentication-popup,
html.gaf-motion-active #authentication-popup *,
html.gaf-motion-active #ditur-popup-container,
html.gaf-motion-active #ditur-popup-container *,
html.gaf-motion-active #confirmOverlay,
html.gaf-motion-active #confirmOverlay *,
html.gaf-motion-active #confirmBox,
html.gaf-motion-active #confirmBox *,
html.gaf-motion-active #diturelastic-filters,
html.gaf-motion-active #diturelastic-filters *,
html.gaf-motion-active iframe[src*="bankid.no"],
html.gaf-motion-active iframe[src*="morrowbank.no"],
html.gaf-motion-active iframe[src*="morrowbank.com"] {
  animation-duration: revert-layer !important;
  animation-iteration-count: revert-layer !important;
  animation-delay: revert-layer !important;
  animation-play-state: running !important;
  transition-duration: revert-layer !important;
  transition-delay: revert-layer !important;
}
`.trim();

/**
 * Moderate: stop *infinite* decorative loops; leave one-shot reveals alone.
 * Uses animation-iteration-count: 1 so infinite keyframes play once then end
 * (including at final keyframe opacity for fade-ins that were wrongly infinite).
 * Does not set animation-duration to 0.01ms — that breaks progressive image UI.
 */
export const MODERATE_CSS = `
/* GAF moderate motion — kill loops, keep load/reveal animations */
html.gaf-motion-active *,
html.gaf-motion-active *::before,
html.gaf-motion-active *::after {
  scroll-behavior: auto !important;
}

/* Infinite / marquee-style only: force a single iteration so they settle */
html.gaf-motion-active *:not(img):not(picture):not(video):not(source):not(canvas),
html.gaf-motion-active *:not(img):not(picture):not(video):not(source):not(canvas)::before,
html.gaf-motion-active *:not(img):not(picture):not(video):not(source):not(canvas)::after {
  animation-iteration-count: 1 !important;
}

/* Never touch media elements' own animations / transitions */
html.gaf-motion-active img,
html.gaf-motion-active picture,
html.gaf-motion-active video,
html.gaf-motion-active canvas,
html.gaf-motion-active svg image {
  animation-duration: revert-layer !important;
  animation-iteration-count: revert-layer !important;
  animation-delay: revert-layer !important;
  animation-play-state: running !important;
  transition-duration: revert-layer !important;
  transition-delay: revert-layer !important;
  opacity: revert-layer !important;
  visibility: revert-layer !important;
}

${INTERACTIVE_UI_PROTECT_CSS}
`.trim();

/** Strict: near-total freeze — may still break some image reveals; use carefully. */
export const STRICT_CSS = `
/* GAF strict motion filter */
html.gaf-motion-active *,
html.gaf-motion-active *::before,
html.gaf-motion-active *::after {
  animation-duration: 0.001ms !important;
  animation-iteration-count: 1 !important;
  animation-delay: 0s !important;
  transition-duration: 0.001ms !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}

/* Still protect photos from being left invisible */
html.gaf-motion-active img,
html.gaf-motion-active picture,
html.gaf-motion-active video,
html.gaf-motion-active canvas {
  animation: none !important;
  transition: none !important;
  opacity: 1 !important;
  visibility: visible !important;
}

${INTERACTIVE_UI_PROTECT_CSS}
`.trim();

export function cssForMotionLevel(level) {
  if (level === 'strict') return STRICT_CSS;
  if (level === 'moderate') return MODERATE_CSS;
  return '';
}

/**
 * Ensure a style tag exists in the given document and reflects the level.
 * Returns true if the style is active.
 */
export function applyMotionStyle(doc, level) {
  if (!doc?.documentElement) return false;
  const css = cssForMotionLevel(level);
  let el = doc.getElementById?.(STYLE_ELEMENT_ID);

  if (!css) {
    el?.remove?.();
    doc.documentElement.classList?.remove?.('gaf-motion-active');
    return false;
  }

  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    el.setAttribute('data-gaf', 'motion');
    const parent = doc.head || doc.documentElement;
    parent.appendChild(el);
  }

  if (el.textContent !== css) {
    el.textContent = css;
  }
  doc.documentElement.classList?.add?.('gaf-motion-active');
  return true;
}

export function removeMotionStyle(doc) {
  if (!doc) return;
  doc.getElementById?.(STYLE_ELEMENT_ID)?.remove?.();
  doc.documentElement?.classList?.remove?.('gaf-motion-active');
}
