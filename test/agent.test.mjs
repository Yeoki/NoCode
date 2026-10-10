import test from 'node:test';
import assert from 'node:assert/strict';
import { CodingAgent } from '../dist/agent.js';

const call = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const reply = (content, tool_calls) => ({ choices: [{ index: 0, finish_reason: tool_calls ? 'tool_calls' : 'stop', logprobs: null, message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}), refusal: null } }] });
function setup(responses, approved = false) {
  const requests = [], invocations = [], prompts = [];
  const tools = Object.fromEntries(['listFiles', 'readFile', 'writeFile', 'runCommand'].map(name => [name, async (...args) => {
    invocations.push({ name, args });
    return { ok: true, output: 'tool output' };
  }]));
  const agent = new CodingAgent(tools, async prompt => { prompts.push(prompt); return approved; }, async request => {
    requests.push(structuredClone(request));
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'Unexpected model request');
    return response;
  });
  return { agent, requests, invocations, prompts, tools };
}

test('mocked loop sends tool results and retains conversation across turns', async () => {
  const s = setup([reply(null, [call('list_files', {})]), reply('Listed.'), reply('Next answer.')]);
  assert.equal(await s.agent.run('Inspect'), 'Listed.');
  assert.deepEqual(s.invocations, [{ name: 'listFiles', args: ['.'] }]);
  const result = s.requests[1].messages.at(-1);
  assert.equal(result.tool_call_id, 'call-1');
  assert.deepEqual(JSON.parse(result.content), { ok: true, output: 'tool output' });
  assert.equal(await s.agent.run('Next'), 'Next answer.');
  assert.equal(s.requests[2].messages.at(-2).content, 'Listed.');
  assert.deepEqual(s.prompts, []);
});

test('invalid JSON, null, wrong types, missing/extra fields and unknown tools return errors', async () => {
  const cases = [
    ['read_file', '{'], ['read_file', null], ['read_file', {}], ['read_file', { path: 7 }],
    ['read_file', { path: '' }], ['write_file', { path: 'x' }],
    ['write_file', { path: 'x', content: false }], ['run_command', { command: 'echo', args: [1] }],
    ['run_command', { command: 'echo' }], ['list_files', { extra: true }],
    ['missing_tool', {}], ['toString', {}]
  ];
  const calls = cases.map(([name, args], i) => call(name, args, `call-${i}`));
  const s = setup([reply(null, calls), reply('Recovered.')], true);
  assert.equal(await s.agent.run('Go'), 'Recovered.');
  const results = s.requests[1].messages.filter(m => m.role === 'tool');
  assert.equal(results.length, calls.length);
  results.forEach((r, i) => { assert.equal(r.tool_call_id, calls[i].id); assert.equal(JSON.parse(r.content).ok, false); });
  assert.deepEqual(s.invocations, []);
  assert.deepEqual(s.prompts, []);
});

for (const approved of [false, true]) {
  test(`writes and commands require explicit approval: ${approved}`, async () => {
    const s = setup([reply(null, [call('write_file', { path: 'x.ts', content: 'a\n\u001b' }, 'write'), call('run_command', { command: 'echo', args: ['one two', ';'] }, 'run')]), reply('Done')], approved);
    await s.agent.run('Change it');
    assert.equal(s.prompts.length, 2);
    assert.match(s.prompts[0], /"x.ts"/);
    assert.match(s.prompts[0], /a\\n\\u001b/);
    assert.match(s.prompts[1], /not sandboxed/);
    assert.match(s.prompts[1], /\["one two",";"\]/);
    assert.equal(s.invocations.length, approved ? 2 : 0);
    const results = s.requests[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    assert.ok(results.every(r => r.ok === approved));
  });
}

test('unexpected tool failure still answers every tool call', async () => {
  const s = setup([reply(null, [call('read_file', { path: 'x' }, 'bad'), call('list_files', {}, 'good')]), reply('Recovered')]);
  s.tools.readFile = async () => { throw new Error('Read failed'); };
  assert.equal(await s.agent.run('Go'), 'Recovered');
  const results = s.requests[1].messages.filter(m => m.role === 'tool');
  assert.deepEqual(JSON.parse(results[0].content), { ok: false, error: 'Read failed' });
  assert.equal(JSON.parse(results[1].content).ok, true);
});

test('loop stops after eight model calls and leaves all tool calls answered', async () => {
  const s = setup([...Array.from({ length: 8 }, (_, i) => reply(null, [call('list_files', {}, `c${i}`)])), reply('Next')]);
  assert.match(await s.agent.run('Go'), /maximum tool steps/);
  assert.equal(s.requests.length, 8);
  assert.equal(s.invocations.length, 8);
  assert.equal(await s.agent.run('Continue'), 'Next');
  assert.equal(s.requests[8].messages.filter(m => m.role === 'tool').length, 8);
});

test('empty response and API errors are explicit; the next turn can recover', async () => {
  const s = setup([{ choices: [] }, new Error('API unavailable'), reply('Recovered')]);
  assert.equal(await s.agent.run('First'), 'No response from model.');
  await assert.rejects(s.agent.run('Second'), /API unavailable/);
  assert.equal(await s.agent.run('Third'), 'Recovered');
});
