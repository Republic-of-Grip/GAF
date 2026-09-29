import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Content scripts cannot import modules, so the host lists are duplicated.
// Fail loudly when one copy drifts (a missing host silently breaks a checkout).
const FILES = [
  'src/core/settings.mjs',
  'src/core/interaction-guard.mjs',
  'src/content/early.js',
  'src/content/unstick-early.js',
];

function regexLiteral(file, name) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const m = src.match(new RegExp(`${name}\\s*=\\s*(/.+/[a-z]*);`));
  assert.ok(m, `${name} not found in ${file}`);
  return m[1];
}

test('PAYMENT_AUTH_HOST_RE is identical in every copy', () => {
  const [first, ...rest] = FILES.map((f) => regexLiteral(f, 'PAYMENT_AUTH_HOST_RE'));
  rest.forEach((lit, i) => assert.equal(lit, first, FILES[i + 1]));
});

for (const name of ['PAYMENT_AUTH_TEXT_RE', 'AUTH_ID_CLASS_RE']) {
  test(`${name} is identical in every copy`, () => {
    const files = ['src/core/interaction-guard.mjs', 'src/content/unstick-early.js'];
    const [a, b] = files.map((f) => regexLiteral(f, name));
    assert.equal(b, a);
  });
}

test('early.js and css-motion.mjs protect CSS stay aligned', () => {
  const early = readFileSync(new URL('../src/content/early.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../src/core/css-motion.mjs', import.meta.url), 'utf8');
  const block = (src) => src.match(/INTERACTIVE_UI_PROTECT_CSS = `([\s\S]*?)`/)[1].trim();
  assert.equal(block(early), block(core));
});
