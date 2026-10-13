import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('../scripts/with-codex-api-key.mjs', import.meta.url));
const probe = `console.log(JSON.stringify({
  keyMatches: process.env.OPENAI_API_KEY === 'fixture-api-key',
  baseURL: process.env.OPENAI_BASE_URL,
  wireApi: process.env.OPENAI_WIRE_API,
  model: process.env.OPENAI_MODEL,
  args: process.argv.slice(1)
}))`;

async function fixture(t, config, auth = { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api-key' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nocode-codex-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (auth !== undefined) await writeFile(path.join(root, 'auth.json'), JSON.stringify(auth));
  if (config !== undefined) await writeFile(path.join(root, 'config.toml'), config);
  return root;
}

function run(root, overrides = {}, args = [], code = probe) {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_WIRE_API', 'OPENAI_MODEL', 'NOCODE_REUSE_CODEX_ENDPOINT']) delete env[key];
  return spawnSync(process.execPath, [bridge, process.execPath, '-e', code, ...args], {
    env: { ...env, CODEX_HOME: root, ...overrides }, encoding: 'utf8', timeout: 5000
  });
}

function result(output) {
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.doesNotMatch(output.stdout, /fixture-api-key/);
  return JSON.parse(output.stdout);
}

test('Codex bridge prefers an exported key and preserves explicit endpoint settings without opt-in', async t => {
  const root = await fixture(t, 'invalid TOML', { auth_mode: 'apikey', OPENAI_API_KEY: 'different-key' });
  const r = result(run(root, {
    OPENAI_API_KEY: ' fixture-api-key ', OPENAI_BASE_URL: 'https://explicit.invalid/v1', OPENAI_WIRE_API: 'chat', OPENAI_MODEL: 'explicit-model'
  }));
  assert.equal(r.keyMatches, true);
  assert.equal(r.baseURL, 'https://explicit.invalid/v1');
  assert.equal(r.wireApi, 'chat');
  assert.equal(r.model, 'explicit-model');
});

test('Codex bridge reuses API-key auth without importing endpoint or model settings by default', async t => {
  const root = await fixture(t, 'invalid TOML');
  assert.deepEqual(result(run(root)), { keyMatches: true, args: [] });
});

test('Codex bridge rejects unsupported or empty authentication before launching a child', async t => {
  for (const auth of [null, { auth_mode: 'chatgpt', OPENAI_API_KEY: 'fixture-api-key' }, { auth_mode: 'apikey', OPENAI_API_KEY: ' ' }]) {
    const root = await fixture(t, undefined, auth);
    const r = run(root);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /API-key authentication/);
    assert.doesNotMatch(r.stderr, /fixture-api-key|TypeError/);
  }
});

const providerConfig = `model = 'fixture-model'
model_provider = "active.api"
[model_providers.inactive]
base_url = "https://inactive.invalid/v1"
wire_api = "chat"
[model_providers."active.api"]
base_url = 'https://active.invalid/v1' # selected endpoint
wire_api = "responses"
[profiles.unselected]
model = "unselected-model"
model_provider = "inactive"
`;

test('Codex bridge selects the configured provider regardless of table order or quoted TOML keys', async t => {
  const root = await fixture(t, providerConfig);
  const r = result(run(root, { NOCODE_REUSE_CODEX_ENDPOINT: '1' }));
  assert.equal(r.keyMatches, true);
  assert.equal(r.baseURL, 'https://active.invalid/v1');
  assert.equal(r.wireApi, 'responses');
  assert.equal(r.model, 'fixture-model');
});

test('Codex bridge respects environment overrides when endpoint reuse is enabled', async t => {
  const root = await fixture(t, providerConfig);
  const r = result(run(root, {
    NOCODE_REUSE_CODEX_ENDPOINT: '1', OPENAI_BASE_URL: ' https://override.invalid/v1 ', OPENAI_WIRE_API: ' chat ', OPENAI_MODEL: ' override-model '
  }));
  assert.equal(r.baseURL, 'https://override.invalid/v1');
  assert.equal(r.wireApi, 'chat');
  assert.equal(r.model, 'override-model');
});

test('Codex bridge uses the built-in OpenAI provider when no custom provider is selected', async t => {
  const root = await fixture(t, `model = "fixture-model"
openai_base_url = "https://builtin.invalid/v1"
[model_providers.inactive]
base_url = "https://inactive.invalid/v1"
wire_api = "chat"
`);
  const r = result(run(root, { NOCODE_REUSE_CODEX_ENDPOINT: '1' }));
  assert.equal(r.baseURL, 'https://builtin.invalid/v1');
  assert.equal(r.wireApi, 'responses');
});

test('Codex bridge fails for a missing selected provider or endpoint instead of using another provider', async t => {
  for (const config of [
    'model_provider = "missing"\n[model_providers.inactive]\nbase_url = "https://inactive.invalid/v1"',
    'model_provider = "active"\n[model_providers.inactive]\nbase_url = "https://inactive.invalid/v1"\n[model_providers.active]\nwire_api = "responses"'
  ]) {
    const root = await fixture(t, config);
    const r = run(root, { NOCODE_REUSE_CODEX_ENDPOINT: '1' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /provider|base_url/);
  }
});

test('Codex bridge reports unreadable or malformed config without printing its contents', async t => {
  for (const config of [undefined, 'model_provider = "fixture-api-key']) {
    const root = await fixture(t, config);
    const r = run(root, { NOCODE_REUSE_CODEX_ENDPOINT: '1' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Codex config could not be read or parsed/);
    assert.doesNotMatch(r.stderr, /fixture-api-key/);
  }
});

test('Codex bridge preserves literal arguments and propagates the child exit code', async t => {
  const root = await fixture(t);
  const args = ['a; echo injected', 'two words'];
  assert.deepEqual(result(run(root, {}, args)).args, args);
  const r = run(root, {}, [], 'process.exit(7)');
  assert.equal(r.status, 7);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});
