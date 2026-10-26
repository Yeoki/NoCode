# NoCode

NoCode is a small, extensible TypeScript coding-agent CLI inspired by Codex, Claude Code, OpenCode, and Pi.

## MVP goals

- Interactive REPL
- Provider abstraction for an OpenAI-compatible model
- Injectable completion providers for offline tests and alternate backends
- Safe workspace-scoped file tools
- Bounded conversation context with an optional summarization hook
- Workspace-local session memory that resumes conversation history across restarts
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

Session memory is enabled by the CLI by default. It stores the wire-native
conversation in `.nocode/session.json` under the selected workspace and restores
it when the same session starts again. Set `NOCODE_SESSION_ID` to keep multiple
independent sessions, or `NOCODE_SESSION_PATH` to choose another file. Library
users can pass `sessionPath` and `sessionId` in `CodingAgent` options. Persistence
is atomic and versioned; malformed snapshots are ignored, and persistence is
disabled when `sessionPath` is not supplied.

When Codex is logged in with an API key on the same computer, the local bridge can reuse that key without copying it into this repository:

```bash
npm run dev:codex -- /path/to/workspace
```

The normal `dev:codex` path reuses only the key. To also reuse the endpoint, protocol, and model from Codex's user configuration, explicitly opt in:

```bash
NOCODE_REUSE_CODEX_ENDPOINT=1 npm run dev:codex -- /path/to/workspace
```

This is intended for a trusted custom endpoint configured in Codex. The endpoint may receive the same API key, so review the `base_url` before enabling it.

Endpoint reuse reads `${CODEX_HOME:-~/.codex}/config.toml` and selects the custom
provider named by its top-level `model_provider`. With the built-in `openai` provider,
it uses `openai_base_url` or the standard OpenAI endpoint. Explicit `OPENAI_BASE_URL`,
`OPENAI_WIRE_API`, and `OPENAI_MODEL` values take precedence. This bridge reads only
that user configuration file; it does not resolve Codex CLI overrides or profile files.

For the compiled CLI:

```bash
npm run build
npm run start:codex -- /path/to/workspace
```

The bridge prefers an existing `OPENAI_API_KEY`. If it is absent, it reads `OPENAI_API_KEY` from `${CODEX_HOME:-~/.codex}/auth.json` only when Codex is using API-key authentication. It never writes the key to the project or prints it. A normal Platform API key exported as `OPENAI_API_KEY` remains the portable configuration.
