# NoCode

NoCode is a small, extensible TypeScript coding-agent CLI inspired by Codex, Claude Code, OpenCode, and Pi.

## MVP goals

- Interactive REPL
- Provider abstraction for an OpenAI-compatible model
- Safe workspace-scoped file tools
- Explicit confirmation before shell commands
- Simple agent loop with tool-call handling

## Development

```bash
npm install
npm run dev
```

Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` before running. The default model is `gpt-4.1-mini`.
