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

test('Responses API loop sends function_call_output and preserves tool history', async () => {
  const requests = [], invocations = [];
  const tools = {
    listFiles: async (...args) => {
      invocations.push(args);
      return { ok: true, output: 'tool output' };
    },
    readFile: async () => ({ ok: true, output: '' }),
    writeFile: async () => ({ ok: true, output: '' }),
    runCommand: async () => ({ ok: true, output: '' })
  };
  const responses = [
    { output: [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'list_files', arguments: '{}' }], output_text: '' },
    { output: [], output_text: 'Listed.' }
  ];
  const agent = new CodingAgent(tools, async () => false, undefined, async request => {
    requests.push(structuredClone(request));
    return responses.shift();
  });

  assert.equal(await agent.run('Inspect'), 'Listed.');
  assert.deepEqual(invocations, [['.']]);
  assert.equal(requests[0].tools[0].type, 'function');
  assert.equal(requests[0].tools[0].name, 'list_files');
  assert.equal(requests[0].store, false);
  assert.deepEqual(requests[1].input.at(-1), {
    type: 'function_call_output',
    call_id: 'call-1',
    output: JSON.stringify({ ok: true, output: 'tool output' })
  });
});

test('Chat API normalizes incomplete tool calls before replaying them', async () => {
  const s = setup([
    reply(null, [{ type: 'function', function: { name: 'list_files' } }]),
    reply('Recovered.')
  ]);
  assert.equal(await s.agent.run('Inspect'), 'Recovered.');
  assert.deepEqual(s.requests[1].messages.find(message => message.role === 'assistant').tool_calls, [{
    type: 'function',
    id: 'tool-1-1',
    function: { name: 'list_files', arguments: 'null' }
  }]);
  assert.match(JSON.parse(s.requests[1].messages.find(message => message.role === 'tool').content).error, /Expected object, received null/);
});

test('Responses API surfaces malformed provider output through the error event', async () => {
  const events = [];
  const tools = { listFiles: async () => ({ ok: true, output: '' }) };
  const agent = new CodingAgent(tools, async () => false, undefined, {
    onEvent: event => events.push(event),
    completeResponses: async () => ({ output: [null], output_text: '' })
  });
  await assert.rejects(agent.run('Inspect'), /invalid Responses output item/);
  assert.deepEqual(events.map(event => event.type), ['thinking', 'error']);
});

test('Responses API converts incomplete function calls into structured tool errors', async () => {
  const requests = [];
  const tools = { listFiles: async () => ({ ok: true, output: '' }) };
  const responses = [
    { output: [{ type: 'function_call', id: 'fc-1', name: 'list_files' }], output_text: '' },
    { output: [], output_text: 'Recovered.' }
  ];
  const agent = new CodingAgent(tools, async () => false, undefined, {
    completeResponses: async request => { requests.push(structuredClone(request)); return responses.shift(); }
  });
  assert.equal(await agent.run('Inspect'), 'Recovered.');
  assert.deepEqual(requests[1].input.slice(0, 2), [
    { role: 'user', content: 'Inspect' },
    { type: 'function_call', id: 'fc-1', call_id: 'tool-1-1', name: 'list_files', arguments: 'null' }
  ]);
  assert.deepEqual(requests[1].input.at(-1), {
    type: 'function_call_output',
    call_id: 'tool-1-1',
    output: JSON.stringify({ ok: false, error: 'Invalid arguments for list_files: [\n  {\n    "code": "invalid_type",\n    "expected": "object",\n    "received": "null",\n    "path": [],\n    "message": "Expected object, received null"\n  }\n]' })
  });
});

test('Responses API normalizes missing function names before replaying them', async () => {
  const requests = [];
  const tools = { listFiles: async () => ({ ok: true, output: '' }) };
  const responses = [
    { output: [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', arguments: '{}' }], output_text: '' },
    { output: [], output_text: 'Recovered.' }
  ];
  const agent = new CodingAgent(tools, async () => false, undefined, {
    completeResponses: async request => { requests.push(structuredClone(request)); return responses.shift(); }
  });
  assert.equal(await agent.run('Inspect'), 'Recovered.');
  assert.equal(requests[1].input[1].name, '(unknown)');
  assert.match(JSON.parse(requests[1].input[2].output).error, /Unknown tool: \(unknown\)/);
});

test('Responses API makes blank provider content visible instead of looking like no response', async () => {
  for (const output_text of ['', '   ', '\n\t']) {
    const agent = new CodingAgent({ listFiles: async () => ({ ok: true, output: '' }) }, async () => false, undefined, {
      completeResponses: async () => ({ output: [], output_text })
    });
    assert.equal(await agent.run('Say something'), '(empty response)');
  }
});

const responseReply = text => ({
  output: [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
  output_text: text
});

function setupResponses(responses, options = {}) {
  const requests = [], invocations = [];
  const tools = {
    listFiles: async (...args) => {
      invocations.push(args);
      return { ok: true, output: 'tool output' };
    }
  };
  const agent = new CodingAgent(tools, async () => false, undefined, {
    ...options,
    completeResponses: async request => {
      requests.push(structuredClone(request));
      const response = responses.shift();
      assert.ok(response, 'Unexpected Responses request');
      return response;
    }
  });
  return { agent, requests, invocations };
}

test('Responses bounds old turns and passes text history to the summarization hook', async () => {
  const summaries = [];
  const s = setupResponses(Array.from({ length: 12 }, () => responseReply('turn complete')), {
    model: 'offline-responses-model',
    maxHistoryMessages: 4,
    summarizeHistory: messages => { summaries.push(messages); return 'older turns summarized'; }
  });
  for (let i = 0; i < 12; i += 1) assert.equal(await s.agent.run(`turn ${i}`), 'turn complete');
  assert.ok(s.requests.every(request => request.model === 'offline-responses-model' && request.input.length + 1 <= 4));
  assert.equal(s.requests.at(-1).input.at(-1).content, 'turn 11');
  assert.ok(summaries.some(messages => messages.some(message => message.role === 'user' && message.content === 'turn 0')));
  assert.ok(summaries.some(messages => messages.some(message => message.role === 'assistant' && message.content === 'turn complete')));
  assert.ok(s.requests.some(request => request.input.some(item => item.role === 'system' && item.content.includes('older turns summarized'))));
});

test('Responses compaction keeps reasoning and parallel function calls with every result', async () => {
  const reasoning = { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'opaque-fixture' };
  const calls = ['first', 'second'].map(id => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name: 'list_files', arguments: '{}' }));
  const s = setupResponses([responseReply('Earlier answer'), { output: [reasoning, ...calls], output_text: '' }, responseReply('Done')], {
    maxHistoryMessages: 8,
    summarizeHistory: () => 'Earlier turn'
  });
  await s.agent.run('Earlier request');
  assert.equal(await s.agent.run('Inspect'), 'Done');
  const input = s.requests[2].input;
  assert.equal(input.length + 1, 8);
  assert.equal(input[1].content, 'Inspect');
  assert.deepEqual(input.slice(2, 5), [reasoning, ...calls]);
  assert.deepEqual(input.slice(5).map(item => item.call_id), ['first', 'second']);
  assert.ok(input.slice(5).every(item => item.type === 'function_call_output' && JSON.parse(item.output).ok));
  assert.equal(s.invocations.length, 2);
});

test('Responses preserves an oversized current tool turn and evicts it on the next user turn', async () => {
  const reasoning = { type: 'reasoning', id: 'reasoning', summary: [] };
  const toolCall = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'list_files', arguments: '{}' };
  const s = setupResponses([{ output: [reasoning, toolCall], output_text: '' }, responseReply('Done'), responseReply('Next answer')], { maxHistoryMessages: 4 });
  assert.equal(await s.agent.run('Inspect'), 'Done');
  assert.deepEqual(s.requests[1].input.slice(1, 3), [reasoning, toolCall]);
  assert.equal(s.requests[1].input.at(-1).call_id, 'call-1');
  assert.equal(s.requests[1].input[0].content, 'Inspect');
  assert.equal(await s.agent.run('Next'), 'Next answer');
  assert.deepEqual(s.requests[2].input, [{ role: 'user', content: 'Next' }]);
  assert.equal(s.invocations.length, 1);
});

test('Responses falls back to recent complete turns when summarization fails or is empty', async () => {
  for (const summarizeHistory of [() => '', () => { throw new Error('Summary unavailable'); }]) {
    const s = setupResponses(Array.from({ length: 8 }, () => responseReply('Done')), { maxHistoryMessages: 4, summarizeHistory });
    for (let i = 0; i < 8; i += 1) assert.equal(await s.agent.run(`turn ${i}`), 'Done');
    assert.ok(s.requests.every(request => request.input.length + 1 <= 4));
    assert.equal(s.requests.at(-1).input.at(-1).content, 'turn 7');
    assert.ok(s.requests.every(request => request.input[0].role === 'user'));
  }
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

test('blank provider content is visible instead of looking like no response', async () => {
  for (const content of ['', '   ']) {
    const s = setup([reply(content)]);
    assert.equal(await s.agent.run('Say something'), '(empty response)');
  }
});

test('progress callback reports thinking, tools, results and final answer', async () => {
  const events = [];
  const s = setup([reply(null, [call('list_files', {})]), reply('Done')]);
  const agent = new CodingAgent(s.tools, async () => false, async request => {
    const response = s.requests.length === 0 ? reply(null, [call('list_files', {})]) : reply('Done');
    s.requests.push(structuredClone(request));
    return response;
  }, { onEvent: event => events.push(event) });
  assert.equal(await agent.run('Inspect'), 'Done');
  assert.deepEqual(events.map(event => event.type), [
    'thinking', 'response', 'tool_start', 'tool_result', 'thinking', 'response', 'final'
  ]);
  assert.equal(events.find(event => event.type === 'tool_start').name, 'list_files');
  assert.equal(events.find(event => event.type === 'tool_result').result.ok, true);
  assert.equal(events.at(-1).content, 'Done');
});

test('provider failures are surfaced to progress callbacks and callers', async () => {
  const events = [];
  const agent = new CodingAgent({}, async () => false, async () => { throw new Error('offline'); }, { onProgress: event => events.push(event) });
  await assert.rejects(agent.run('Go'), /offline/);
  assert.deepEqual(events.map(event => event.type), ['thinking', 'error']);
  assert.equal(events.at(-1).error, 'offline');
});

test('accepts an injectable provider object without constructing an OpenAI client', async () => {
  const requests = [];
  const tools = Object.fromEntries(['listFiles', 'readFile', 'writeFile', 'applyPatch', 'runCommand'].map(name => [name, async () => ({ ok: true, output: '' })]));
  const provider = { complete: async request => { requests.push(request); return reply('Offline response.'); } };
  const agent = new CodingAgent(tools, async () => false, provider);
  assert.equal(await agent.run('Use the fake provider'), 'Offline response.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].role, 'system');
});

test('bounds context and invokes the optional summarization hook', async () => {
  const summaries = [];
  const requests = [];
  const tools = Object.fromEntries(['listFiles', 'readFile', 'writeFile', 'applyPatch', 'runCommand'].map(name => [name, async () => ({ ok: true, output: '' })]));
  const agent = new CodingAgent(tools, async () => false, async request => {
    requests.push(request);
    return reply('turn complete');
  }, { maxHistoryMessages: 6, summarizeHistory: async messages => {
    summaries.push(messages);
    return 'older turns summarized';
  } });
  for (let i = 0; i < 8; i += 1) assert.equal(await agent.run(`turn ${i}`), 'turn complete');
  assert.ok(summaries.length > 0);
  assert.ok(requests.every(request => request.messages.length <= 6));
  assert.ok(requests.some(request => request.messages.some(message => message.role === 'system' && String(message.content).includes('older turns summarized'))));
});
