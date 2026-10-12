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

Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` before running. The default model is `gpt-4.1-mini`.

`CodingAgent` accepts either the original completion function form or a provider
object implementing `complete(request)`. Pass `maxHistoryMessages` and
`summarizeHistory` in the fourth constructor argument to control context
compaction. The `apply_patch` tool uses exact string replacements and requires
each replacement to match once unless `all: true` is specified.
