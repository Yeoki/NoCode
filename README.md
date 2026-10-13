# NoCode

NoCode is a small, extensible TypeScript coding-agent CLI inspired by Codex, Claude Code, OpenCode, and Pi.

## MVP goals

- Interactive REPL
- Provider abstraction for an OpenAI-compatible model
- Injectable completion providers for offline tests and alternate backends
- Safe workspace-scoped file tools
- Bounded conversation context with an optional summarization hook
- Deterministic, confirmation-gated text patches for focused edits
- Explicit confirmation before shell commands
- Simple agent loop with tool-call handling

## Development

```bash
npm install
npm run dev
```

Set `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL`, `OPENAI_WIRE_API`, and `OPENAI_MODEL` before running. The default model is `gpt-4.1-mini` and the default wire API is Chat Completions.

Set `OPENAI_WIRE_API=responses` to use the Responses API with the same function-tool loop.

`CodingAgent` accepts either the original completion function form or a provider
object implementing `complete(request)`. Pass `maxHistoryMessages` and
`summarizeHistory` in the fourth constructor argument to control context
compaction for both APIs. For Responses, the budget counts input items plus system
instructions; an oversized current turn stays intact so reasoning, calls, and results
remain together. The summary hook receives text messages, with tool items represented
as JSON. To inject a Responses API provider, pass it as `completeResponses` in that
options object or directly as the fourth argument. The `apply_patch` tool uses exact
string replacements and requires each replacement to match once unless `all: true`
is specified.

Pass `onEvent` (or its `onProgress` alias) in the options object to receive
safe lifecycle updates such as `thinking`, `tool_start`, `tool_result`,
`error`, and `final`. These events expose progress and tool metadata only; they
never expose hidden model reasoning. The CLI renders a spinner while waiting
for a provider and writes tool summaries to stderr so the final answer on
stdout remains pipe-friendly.
