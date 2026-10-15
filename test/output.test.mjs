import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAssistantOutput } from '../dist/output.js';

test('formats JSON objects and nested JSON strings for display', () => {
  assert.equal(formatAssistantOutput('{"ok":true,"files":["a.ts"]}'), '{\n  "ok": true,\n  "files": [\n    "a.ts"\n  ]\n}');
  assert.equal(formatAssistantOutput('"{\\"ok\\":true}"'), '{\n  "ok": true\n}');
});

test('keeps ordinary text and fences readable', () => {
  assert.equal(formatAssistantOutput('hello world'), 'hello world');
  assert.equal(formatAssistantOutput('```json\n{"ok":true}\n```'), '{\n  "ok": true\n}');
  assert.equal(formatAssistantOutput('   '), '(empty response)');
});
