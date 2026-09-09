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
