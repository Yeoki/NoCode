import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const root = path.dirname(entry);
function run(args = [], input = '', key = '') {
  return spawnSync(process.execPath, [entry, ...args], { input, encoding: 'utf8', timeout: 5000, env: { ...process.env, OPENAI_API_KEY: key } });
}

test('CLI help works without credentials', () => {
  const r = run(['--help']); assert.equal(r.status, 0); assert.match(r.stdout, /Usage: nocode/); assert.equal(r.stderr, '');
});
test('CLI missing credentials produces friendly nonzero startup error', () => {
  const r = run([root]); assert.equal(r.status, 1); assert.match(r.stderr, /Set OPENAI_API_KEY/); assert.doesNotMatch(r.stderr, /at main|node:internal/);
});
test('CLI invalid workspace produces clean error before model construction', () => {
  for (const target of [path.join(root, 'not-a-directory-that-exists'), entry]) {
    const r = run([target]); assert.equal(r.status, 1); assert.match(r.stderr, /NoCode:/); assert.doesNotMatch(r.stderr, /at main|node:internal/);
  }
});
test('CLI consumes exit, blank lines and EOF without any model request', () => {
  for (const input of ['/exit\n', '\n/quit\n', '']) {
    const r = run([root], input, 'offline-placeholder-never-sent');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /NoCode workspace/); assert.equal(r.stderr, '');
  }
});
