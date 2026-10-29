import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodingAgent, ConversationContext } from '../dist/agent.js';

const prefix = 'Previous conversation summary:\n';
const remembered = 'The project uses TypeScript; preserve the public API.';
const summary = text => ({ role: 'system', content: `${prefix}${text}` });
const chatReply = text => ({ choices: [{ message: { role: 'assistant', content: text } }] });
const responseReply = text => ({
  output: [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
  output_text: text
});
const inputOf = (wireApi, request) => wireApi === 'chat' ? request.messages.slice(1) : request.input;
const historyOf = snapshot => snapshot.wireApi === 'chat' ? snapshot.chatMessages.slice(1) : snapshot.responseItems;

async function sessionFile(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nocode-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'session.json');
}

async function writeLegacySnapshot(sessionPath, wireApi, items) {
  await writeFile(sessionPath, JSON.stringify({
    version: 1, sessionId: 'demo', updatedAt: '2026-01-01T00:00:00.000Z', wireApi,
    ...(wireApi === 'chat'
      ? { chatMessages: [{ role: 'system', content: 'Original system prompt' }, ...items] }
      : { responseItems: items })
  }));
}

function setup(wireApi, options = {}, replies) {
  const requests = [];
  const complete = async request => {
    requests.push(structuredClone(request));
    return replies ? replies.shift() : (wireApi === 'chat' ? chatReply('Done') : responseReply('Done'));
  };
  const agent = new CodingAgent({ listFiles: async () => ({ ok: true, output: 'files' }) }, async () => false,
    wireApi === 'chat' ? complete : undefined,
    { sessionId: 'demo', ...options, ...(wireApi === 'responses' ? { completeResponses: complete } : {}) });
  return { agent, requests };
}

for (const wireApi of ['chat', 'responses']) {
  for (const hook of ['absent', 'empty', 'throwing']) {
    test(`${wireApi}: a restored v1 summary survives recompaction when the hook is ${hook}`, async t => {
      const sessionPath = await sessionFile(t);
      await writeLegacySnapshot(sessionPath, wireApi, [summary(remembered), { role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier answer' }]);
      const summarized = [];
      const options = { sessionPath, maxHistoryMessages: 4 };
      if (hook !== 'absent') options.summarizeHistory = messages => {
        summarized.push(messages);
        if (hook === 'throwing') throw new Error('Offline summarizer');
        return ' \n\t';
      };
      const first = setup(wireApi, options);
      await first.agent.run('Continue');
      await first.agent.run('Continue again');
      for (const request of first.requests) {
        const items = inputOf(wireApi, request);
        assert.deepEqual(items[0], summary(remembered));
        assert.equal(items.filter(item => item.role === 'system').length, 1);
        assert.ok(items.length + 1 <= 4);
        assert.ok(!items.some(item => item.content === 'Earlier request'));
      }
      for (const messages of summarized) {
        assert.deepEqual(messages[0], summary(remembered));
        assert.equal(messages.filter(message => message.content === `${prefix}${remembered}`).length, 1);
      }
      const persisted = JSON.parse(await readFile(sessionPath, 'utf8'));
      assert.equal(persisted.version, 1);
      assert.deepEqual(historyOf(persisted)[0], summary(remembered));
      // A further restart must retain the fallback state written by the first agent.
      const restarted = setup(wireApi, { sessionPath, maxHistoryMessages: 4 });
      await restarted.agent.run('After another restart');
      assert.deepEqual(inputOf(wireApi, restarted.requests[0])[0], summary(remembered));
    });
  }

  test(`${wireApi}: successful recompaction folds the prior summary in exactly once`, async t => {
    const sessionPath = await sessionFile(t);
    await writeLegacySnapshot(sessionPath, wireApi, [summary(remembered), { role: 'user', content: 'Newly removed request' }, { role: 'assistant', content: 'Newly removed answer' }]);
    const summarized = [];
    const s = setup(wireApi, {
      sessionPath, maxHistoryMessages: 4,
      summarizeHistory: messages => { summarized.push(structuredClone(messages)); return `Updated summary ${summarized.length}`; }
    });
    await s.agent.run('Keep this turn');
    await s.agent.run('Next turn');
    assert.deepEqual(summarized[0], [summary(remembered), { role: 'user', content: 'Newly removed request' }, { role: 'assistant', content: 'Newly removed answer' }]);
    assert.deepEqual(summarized[1][0], summary('Updated summary 1'));
    assert.equal(summarized[1].filter(message => message.role === 'system').length, 1);
    assert.ok(!summarized[1].some(message => message.content === `${prefix}${remembered}`));
    assert.deepEqual(inputOf(wireApi, s.requests[1])[0], summary('Updated summary 2'));
    assert.deepEqual(historyOf(JSON.parse(await readFile(sessionPath, 'utf8')))[0], summary('Updated summary 2'));
  });

  test(`${wireApi}: a tiny request budget hides the summary without erasing persisted state`, async t => {
    const sessionPath = await sessionFile(t);
    await writeLegacySnapshot(sessionPath, wireApi, [summary(remembered), { role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier answer' }]);
    const small = setup(wireApi, { sessionPath, maxHistoryMessages: 2 });
    await small.agent.run('Small budget');
    assert.deepEqual(inputOf(wireApi, small.requests[0]), [{ role: 'user', content: 'Small budget' }]);
    assert.deepEqual(historyOf(JSON.parse(await readFile(sessionPath, 'utf8')))[0], summary(remembered));
    const larger = setup(wireApi, { sessionPath, maxHistoryMessages: 4 });
    await larger.agent.run('Larger budget after restart');
    assert.deepEqual(inputOf(wireApi, larger.requests[0])[0], summary(remembered));
  });

  test(`${wireApi}: legacy raw history still restores without inventing a summary`, async t => {
    const sessionPath = await sessionFile(t);
    const items = [{ role: 'user', content: `${prefix}This is user text, not summary state.` }, { role: 'assistant', content: 'Earlier answer' }];
    await writeLegacySnapshot(sessionPath, wireApi, items);
    const s = setup(wireApi, { sessionPath });
    await s.agent.run('Continue');
    assert.deepEqual(inputOf(wireApi, s.requests[0]), [...items, { role: 'user', content: 'Continue' }]);
    assert.ok(!historyOf(JSON.parse(await readFile(sessionPath, 'utf8'))).some(item => item.role === 'system'));
  });

  test(`${wireApi}: generated summaries survive a genuine separate-process restart`, async t => {
    const sessionPath = await sessionFile(t);
    const moduleUrl = new URL('../dist/agent.js', import.meta.url).href;
    const script = `
      import { CodingAgent } from ${JSON.stringify(moduleUrl)};
      const [sessionPath, wireApi, phase] = process.argv.slice(1);
      const requests = [];
      const complete = async request => {
        requests.push(request);
        return wireApi === 'chat'
          ? { choices: [{ message: { role: 'assistant', content: 'Done' } }] }
          : { output: [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }], output_text: 'Done' };
      };
      const options = { sessionPath, sessionId: 'demo', maxHistoryMessages: 4,
        ...(phase === 'write' ? { summarizeHistory: () => ${JSON.stringify(remembered)} } : {}),
        ...(wireApi === 'responses' ? { completeResponses: complete } : {}) };
      const agent = new CodingAgent({}, async () => false, wireApi === 'chat' ? complete : undefined, options);
      for (const turn of phase === 'write' ? ['First', 'Second', 'Third'] : ['After restart']) await agent.run(turn);
      process.stdout.write(JSON.stringify(requests));
    `;
    const run = phase => {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, sessionPath, wireApi, phase], {
        encoding: 'utf8', timeout: 10000, env: { ...process.env, OPENAI_API_KEY: '', OPENAI_WIRE_API: 'chat' }
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return JSON.parse(result.stdout);
    };
    const initial = run('write');
    assert.deepEqual(inputOf(wireApi, initial.at(-1))[0], summary(remembered));
    const restored = run('read');
    assert.deepEqual(inputOf(wireApi, restored[0])[0], summary(remembered));
    assert.equal(inputOf(wireApi, restored[0]).at(-1).content, 'After restart');
    assert.deepEqual(historyOf(JSON.parse(await readFile(sessionPath, 'utf8')))[0], summary(remembered));
  });
}

test('Responses hides the summary during an oversized tool turn and restores it afterward', async t => {
  const sessionPath = await sessionFile(t);
  await writeLegacySnapshot(sessionPath, 'responses', [summary(remembered)]);
  const reasoning = { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'opaque-test-fixture' };
  const calls = ['one', 'two'].map(id => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name: 'list_files', arguments: '{}' }));
  const s = setup('responses', { sessionPath, maxHistoryMessages: 4 }, [
    { output: [reasoning, ...calls], output_text: '' }, responseReply('Done'), responseReply('Continued')
  ]);
  await s.agent.run('Inspect');
  assert.deepEqual(s.requests[0].input, [summary(remembered), { role: 'user', content: 'Inspect' }]);
  assert.deepEqual(s.requests[1].input.slice(0, 4), [{ role: 'user', content: 'Inspect' }, reasoning, ...calls]);
  assert.deepEqual(s.requests[1].input.slice(4).map(item => [item.type, item.call_id]), [['function_call_output', 'one'], ['function_call_output', 'two']]);
  assert.deepEqual(historyOf(JSON.parse(await readFile(sessionPath, 'utf8')))[0], summary(remembered));
  const restarted = setup('responses', { sessionPath, maxHistoryMessages: 4 });
  await restarted.agent.run('After restart');
  assert.deepEqual(restarted.requests[0].input, [summary(remembered), { role: 'user', content: 'After restart' }]);
  await s.agent.run('Next turn in original process');
  assert.deepEqual(s.requests[2].input, [summary(remembered), { role: 'user', content: 'Next turn in original process' }]);
});

test('ConversationContext snapshots retain summary state and restore resets it', async () => {
  const context = new ConversationContext('System', { maxMessages: 2 });
  context.restore([{ role: 'system', content: 'System' }, summary(remembered), { role: 'user', content: 'Current' }]);
  assert.deepEqual(await context.getMessages(), [{ role: 'system', content: 'System' }, { role: 'user', content: 'Current' }]);
  assert.equal(context.length, 3);
  assert.deepEqual(context.snapshot()[1], summary(remembered));
  context.restore([{ role: 'system', content: 'System' }, { role: 'user', content: 'Replacement' }]);
  assert.equal(context.length, 2);
  assert.ok(!context.snapshot().some(message => message.content === `${prefix}${remembered}`));
});
