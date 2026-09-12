import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'helium-gaf-debug.sh');
const src = readFileSync(script, 'utf8');

test('Linux debug launcher matches CDP safety and unpacked-load flags', () => {
  assert.match(src, /--remote-debugging-port=/);
  assert.match(src, /--load-extension=/);
  assert.match(src, /Helium-GAF-Debug/);
  assert.match(src, /PORT=9333/);
  assert.doesNotMatch(src, /--remote-allow-origins=\*/);
  assert.doesNotMatch(src, /user-data-dir=.*net\.imput\.Helium/);
});

test('--probe-only exits non-zero when CDP is not responding', () => {
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const probe = spawnSync('bash', [script, '--probe-only', '--port', '19333'], {
    encoding: 'utf8',
  });
  assert.equal(probe.status, 1, probe.stdout + probe.stderr);
  assert.match(probe.stdout, /CDP not responding/);
});
