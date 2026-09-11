import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipAnimation } from '../src/core/scripted-motion.mjs';

function fakeAnim({ tag = 'DIV', iterations = Infinity, duration = 10000, playState = 'running' } = {}) {
  return {
    playState,
    effect: {
      target: {
        nodeType: 1,
        tagName: tag,
        dataset: {},
        closest() {
          return null;
        },
        matches() {
          return false;
        },
      },
      getComputedTiming() {
        return { iterations, duration };
      },
    },
  };
}

test('skips img and short finite animations', () => {
  assert.equal(shouldSkipAnimation(fakeAnim({ tag: 'IMG', iterations: 1, duration: 400 })), true);
  assert.equal(shouldSkipAnimation(fakeAnim({ tag: 'DIV', iterations: 1, duration: 400 })), true);
  assert.equal(shouldSkipAnimation(fakeAnim({ tag: 'DIV', iterations: Infinity, duration: 10000 })), false);
});

test('pauses only long infinite decorative loops', () => {
  assert.equal(
    shouldSkipAnimation(fakeAnim({ tag: 'DIV', iterations: Infinity, duration: 2000 })),
    false
  );
  assert.equal(
    shouldSkipAnimation(fakeAnim({ tag: 'SPAN', iterations: 100, duration: 8000 })),
    false
  );
});

test('OFF resumes only WAAPI and SVG motion that GAF actually paused', async () => {
  const { pauseAllScriptedMotion, restoreScriptedMotion } = await import('../src/core/scripted-motion.mjs');
  const running = fakeAnim();
  const paused = fakeAnim({ playState: 'paused' });
  let plays = 0;
  for (const a of [running, paused]) {
    a.pause = () => { a.playState = 'paused'; };
    a.play = () => { a.playState = 'running'; plays += 1; };
  }
  let svgPaused = false, svgResumes = 0;
  const svg = {
    querySelector: () => null, closest: () => null,
    animationsPaused: () => svgPaused,
    pauseAnimations: () => { svgPaused = true; },
    unpauseAnimations: () => { svgPaused = false; svgResumes += 1; },
  };
  const doc = {
    getAnimations: () => [running, paused],
    querySelectorAll: (sel) => sel === 'svg' ? [svg] : [],
  };
  pauseAllScriptedMotion(doc);
  pauseAllScriptedMotion(doc);
  assert.equal(running.playState, 'paused');
  restoreScriptedMotion(doc);
  restoreScriptedMotion(doc);
  assert.equal(running.playState, 'running');
  assert.equal(paused.playState, 'paused');
  assert.equal(plays, 1);
  assert.equal(svgResumes, 1);
});
