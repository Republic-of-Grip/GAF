/**
 * Pause Web Animations API timelines and SVG SMIL animations.
 * Complements CSS injection for JS-driven / SMIL motion.
 *
 * Careful: news sites fade lazy images in via short WAAPI/CSS animations.
 * Pausing *all* running animations freezes them at opacity 0 → solid colour tiles
 * (observed on av-avis.no / Polaris). Only pause infinite / long decorative loops.
 */

const MARK = 'gafPaused';

const MEDIA_TAGS = new Set(['IMG', 'PICTURE', 'VIDEO', 'SOURCE', 'CANVAS', 'AUDIO']);

/**
 * True if this animation looks like content reveal / media — leave it alone.
 */
export function shouldSkipAnimation(anim) {
  if (!anim) return true;
  try {
    const target = anim.effect?.target;
    if (target?.nodeType === 1) {
      const tag = target.tagName;
      if (MEDIA_TAGS.has(tag)) return true;
      // Inside a figure/picture link card — common for newspaper teasers
      if (typeof target.closest === 'function') {
        if (target.closest('img, picture, video, figure img, [data-gaf-freeze-canvas]')) {
          return true;
        }
      }
      // Opacity-only short reveals on teaser cards — do not pause
      if (target.matches?.('a, figure, article, [class*="teaser" i], [class*="card" i], [class*="image" i]')) {
        const iters = anim.effect?.getComputedTiming?.()?.iterations;
        const duration = anim.effect?.getComputedTiming?.()?.duration;
        if (iters === 1 || iters === undefined) {
          if (typeof duration === 'number' && duration > 0 && duration < 3000) {
            return true;
          }
        }
      }
    }

    const timing = anim.effect?.getComputedTiming?.();
    if (timing) {
      const iterations = timing.iterations;
      const duration = timing.duration;
      const infinite =
        iterations === Infinity ||
        iterations === 'Infinity' ||
        (typeof iterations === 'number' && iterations > 20);
      // Finite short animations: image fade-ins, UI opens — keep running
      if (!infinite) {
        if (typeof duration === 'number' && duration > 0 && duration < 5000) {
          return true;
        }
        if (iterations === 1 || iterations === undefined) {
          // One-shot without reliable duration — safer to leave alone
          return true;
        }
      }
    }
  } catch {
    // If we can't inspect, skip pausing (fail open for page usability)
    return true;
  }
  return false;
}

/**
 * Pause WAAPI animations under root (document or element).
 * Only infinite / long decorative loops.
 * @returns {number} count of animations paused
 */
export function pauseWebAnimations(root = globalThis.document) {
  if (!root?.getAnimations) return 0;
  let count = 0;
  try {
    const animations = root.getAnimations({ subtree: true });
    for (const anim of animations) {
      try {
        if (anim.playState !== 'running' && anim.playState !== 'pending') continue;
        if (shouldSkipAnimation(anim)) continue;
        anim.pause();
        if (anim.effect?.target?.dataset) {
          anim.effect.target.dataset[MARK] = '1';
        }
        count += 1;
      } catch {
        // ignore individual animation failures
      }
    }
  } catch {
    // getAnimations can throw in odd documents
  }
  return count;
}

/**
 * Pause SVG SMIL animations in the document.
 * Skip SVG that is primarily an icon next to content? Still pause decorative SMIL.
 * @returns {number} count of SVG roots paused
 */
export function pauseSvgAnimations(root = globalThis.document) {
  if (!root?.querySelectorAll) return 0;
  let count = 0;
  try {
    const svgs = root.querySelectorAll('svg');
    for (const svg of svgs) {
      try {
        // Don't pause SVGs that wrap or sit inside image cards with <image href>
        if (svg.querySelector?.('image[href], image[*|href]')) continue;
        // Leave modal / dialog icons alone (Alpine cookie, auth, cart chrome)
        if (
          typeof svg.closest === 'function' &&
          svg.closest(
            'dialog, [role="dialog"], [role="overlay"], [aria-modal="true"], #cookie-popup, #authentication-popup, #ditur-popup-container, #confirmOverlay, #confirmBox'
          )
        ) {
          continue;
        }
        if (typeof svg.pauseAnimations === 'function') {
          svg.pauseAnimations();
          count += 1;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return count;
}

/**
 * Attempt to pause common Lottie / player custom elements without breaking the page.
 */
export function pauseKnownPlayers(root = globalThis.document) {
  if (!root?.querySelectorAll) return 0;
  let count = 0;
  const selectors = [
    'lottie-player',
    'dotlottie-player',
    '[data-lottie]',
    'rapi-lottie',
  ];
  try {
    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        try {
          if (typeof el.pause === 'function') {
            el.pause();
            count += 1;
          } else if (el.shadowRoot) {
            pauseWebAnimations(el.shadowRoot);
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return count;
}

export function pauseAllScriptedMotion(root = globalThis.document) {
  return (
    pauseWebAnimations(root) +
    pauseSvgAnimations(root) +
    pauseKnownPlayers(root)
  );
}
