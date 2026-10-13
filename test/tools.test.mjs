import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceTools } from '../dist/tools.js';

test('workspace tools can write and read a file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nocode-'));
  try {
    const tools = new WorkspaceTools(root);
    assert.equal((await tools.writeFile('nested/hello.txt', 'hello')).ok, true);
    const result = await tools.readFile('nested/hello.txt');
    assert.deepEqual(result, { ok: true, output: 'hello' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace tools apply deterministic structured patches atomically', async t => {
  const { root, tools } = await fixture(t);
  await fs.writeFile(path.join(root, 'patch.txt'), 'one\ntwo\ntwo\n');
  assert.deepEqual(await tools.applyPatch('patch.txt', [{ search: 'one', replace: 'ONE' }]), { ok: true, output: 'Wrote patch.txt' });
  assert.equal(await fs.readFile(path.join(root, 'patch.txt'), 'utf8'), 'ONE\ntwo\ntwo\n');
  const ambiguous = await tools.applyPatch('patch.txt', [{ search: 'two', replace: 'TWO' }]);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /matched 2 locations/);
  assert.deepEqual(await tools.applyPatch('patch.txt', [{ search: 'two', replace: 'TWO', all: true }]), { ok: true, output: 'Wrote patch.txt' });
  assert.equal(await fs.readFile(path.join(root, 'patch.txt'), 'utf8'), 'ONE\nTWO\nTWO\n');
  assert.deepEqual(await tools.applyPatch('patch.txt', [{ search: 'ONE', replace: '$& literal' }]), { ok: true, output: 'Wrote patch.txt' });
  assert.match(await fs.readFile(path.join(root, 'patch.txt'), 'utf8'), /^\$& literal/);
  const missing = await tools.applyPatch('patch.txt', [{ search: 'missing', replace: 'x' }]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /did not match/);
});

test('workspace tools reject paths outside the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nocode-'));
  try {
    const result = await new WorkspaceTools(root).readFile('../secret.txt');
    assert.equal(result.ok, false);
    assert.match(result.error, /escapes the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fs = await import('node:fs/promises');
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nocode-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret'), 'untouched');
  return { root, outside, tools: new WorkspaceTools(root) };
}

test('read/write/list reject directory and final symlinks, including dangling ones', async t => {
  const { root, outside, tools } = await fixture(t);
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.symlink(path.join(outside, 'secret'), path.join(root, 'file-link'));
  await fs.symlink(path.join(outside, 'missing'), path.join(root, 'dangling'));
  for (const result of [await tools.readFile('escape/secret'), await tools.listFiles('escape'), await tools.writeFile('escape/new/deep', 'bad'), await tools.readFile('file-link'), await tools.writeFile('file-link', 'bad'), await tools.writeFile('dangling', 'bad')]) {
    assert.equal(result.ok, false); assert.match(result.error, /Symbolic links/);
  }
  assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'untouched');
  assert.deepEqual((await fs.readdir(outside)).sort(), ['secret']);
  assert.match((await tools.listFiles()).output, /l escape/);
});

test('write rejects traversal, absolute outsiders and sibling-prefix paths', async t => {
  const { root, tools } = await fixture(t);
  for (const p of ['../secret', `${root}-sibling/file`, '/tmp/nocode-outside-test']) {
    const result = await tools.writeFile(p, 'bad');
    assert.equal(result.ok, false); assert.match(result.error, /escapes the workspace/);
  }
});

test('workspace root aliases and relative roots work; interior symlinks are deliberately rejected', async t => {
  const { root, tools } = await fixture(t);
  await fs.mkdir(path.join(root, 'dir'));
  await fs.symlink(path.join(root, 'dir'), path.join(root, 'inside'));
  assert.equal((await tools.writeFile('inside/file', 'no')).ok, false);
  const alias = `${root}-alias`; await fs.symlink(root, alias);
  const aliased = new WorkspaceTools(alias);
  assert.equal((await aliased.writeFile('yes', 'ok')).ok, true);
  assert.deepEqual(await new WorkspaceTools(path.relative(process.cwd(), root)).readFile('yes'), { ok: true, output: 'ok' });
});

test('atomic writes do not mutate external hard-linked files and clean temp files', async t => {
  const { root, outside, tools } = await fixture(t);
  await fs.link(path.join(outside, 'secret'), path.join(root, 'hardlink'));
  assert.equal((await tools.writeFile('hardlink', 'updated')).ok, true);
  assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'untouched');
  assert.equal(await fs.readFile(path.join(root, 'hardlink'), 'utf8'), 'updated');
  assert.deepEqual(await fs.readdir(root), ['hardlink']);
});

test('invalid roots and non-file targets return structured failures', async t => {
  const { root, tools } = await fixture(t);
  assert.equal((await tools.writeFile('.', 'bad')).ok, false);
  assert.equal((await tools.readFile('.')).ok, false);
  assert.equal((await tools.writeFile('', 'bad')).ok, false);
  assert.equal((await new WorkspaceTools(`${root}-missing`).listFiles()).ok, false);
});

test('command execution uses literal argv, workspace cwd and structured failures', async t => {
  const { root, tools } = await fixture(t);
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousCodexKey = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = 'test-secret-openai-key';
  process.env.CODEX_API_KEY = 'test-secret-codex-key';
  t.after(() => {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = previousCodexKey;
  });
  const result = await tools.runCommand(process.execPath, ['-e', 'console.log(process.cwd()); console.log(process.argv[1]); console.error("stderr")', 'a; echo injected']);
  assert.equal(result.ok, true);
  assert.match(result.output, new RegExp(root));
  assert.match(result.output, /a; echo injected/);
  assert.match(result.output, /stderr/);
  const secrets = await tools.runCommand(process.execPath, ['-e', 'console.log(process.env.OPENAI_API_KEY ?? "missing"); console.log(process.env.CODEX_API_KEY ?? "missing")']);
  assert.deepEqual(secrets, { ok: true, output: 'missing\nmissing\n' });
  const failed = await tools.runCommand(process.execPath, ['-e', 'console.error("failure detail"); process.exit(3)']);
  assert.equal(failed.ok, false); assert.match(failed.error, /failure detail/);
  assert.equal((await tools.runCommand('', [])).ok, false);
});
