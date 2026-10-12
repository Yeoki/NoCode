import OpenAI from "openai";
import { z } from "zod";
import { FilePatch, WorkspaceTools, ToolResult } from "./tools.js";

export type ChatCompletionRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
export type ChatCompletionResponse = Pick<OpenAI.Chat.Completions.ChatCompletion, "choices">;

/** A provider can be swapped for an offline fake, another API, or the OpenAI adapter. */
export interface ChatCompletionProvider {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

/** Function form retained for backwards compatibility with the original MVP. */
export type CompletionProvider = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

/** Thin adapter around the official OpenAI client. No client is constructed by tests that inject a provider. */
export class OpenAICompletionProvider implements ChatCompletionProvider {
  private readonly client: OpenAI;

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.client.chat.completions.create(request);
  }
}

// Short alias for consumers that prefer the provider name used by the SDK.
export { OpenAICompletionProvider as OpenAIProvider };

export type ContextSummarizer = (messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) => Promise<string> | string;

export interface ContextOptions {
  /** Maximum number of messages sent to the provider, including the system prompt. */
  maxMessages?: number;
  /** Optional hook used to preserve a compact summary when old messages are removed. */
  summarize?: ContextSummarizer;
}

const DEFAULT_MAX_MESSAGES = 40;
const SUMMARY_PREFIX = "Previous conversation summary:\n";

/**
 * Maintains a bounded conversation while preserving the system prompt and recent turns.
 * Compaction happens immediately before a provider call, so a tool-call batch is kept
 * together while it is being assembled.
 */
export class ConversationContext {
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  private readonly maxMessages: number;
  private readonly summarize?: ContextSummarizer;

  constructor(systemPrompt: string, options: ContextOptions = {}) {
    const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (!Number.isInteger(maxMessages) || maxMessages < 2) throw new Error("maxMessages must be an integer of at least 2");
    this.maxMessages = maxMessages;
    this.summarize = options.summarize;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  add(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): void {
    this.messages.push(message);
  }

  get length(): number {
    return this.messages.length;
  }

  /** Return a bounded snapshot suitable for a chat-completion request. */
  async getMessages(): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    await this.compact();
    return this.messages.slice();
  }

  private async compact(): Promise<void> {
    if (this.messages.length <= this.maxMessages) return;

    const system = this.messages[0]?.role === "system" ? [this.messages[0]] : [];
    const body = this.messages.slice(system.length);
    const budget = Math.max(0, this.maxMessages - system.length);
    let cutAt = Math.max(0, body.length - budget);
    // Never start on a tool/assistant continuation when an earlier user boundary is available.
    while (cutAt < body.length && body[cutAt]?.role !== "user") cutAt += 1;
    const removed = body.slice(0, cutAt);
    if (removed.length === 0) {
      // A single turn can contain more messages than the bound. Keep the newest bounded tail.
      this.messages = [...system, ...body.slice(-budget)];
      return;
    }

    let summary = "";
    if (this.summarize) {
      try { summary = (await this.summarize(removed)).trim(); }
      catch { summary = ""; }
    }
    const summaryMessage = summary ? [{ role: "system" as const, content: `${SUMMARY_PREFIX}${summary}` }] : [];
    const keepBudget = Math.max(0, this.maxMessages - system.length - summaryMessage.length);
    let kept = body.slice(cutAt);
    if (kept.length > keepBudget) {
      kept = keepBudget === 0 ? [] : kept.slice(-keepBudget);
      // Prefer a user boundary when the tail still contains complete turns.
      const firstUser = kept.findIndex((message) => message.role === "user");
      if (firstUser > 0) kept = kept.slice(firstUser);
    }
    this.messages = [...system, ...summaryMessage, ...kept];
  }
}

export interface CodingAgentOptions extends ContextOptions {
  /** Alias for ContextOptions.maxMessages, kept explicit for the agent API. */
  maxHistoryMessages?: number;
  /** Alias for ContextOptions.summarize. */
  summarizeHistory?: ContextSummarizer;
  model?: string;
}

const schemas = {
  list_files: z.object({ path: z.string().min(1).optional() }).strict(),
  read_file: z.object({ path: z.string().min(1) }).strict(),
  write_file: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  apply_patch: z.object({
    path: z.string().min(1),
    patches: z.array(z.object({ search: z.string().min(1), replace: z.string(), all: z.boolean().optional() }).strict()).min(1)
  }).strict(),
  run_command: z.object({ command: z.string().trim().min(1), args: z.array(z.string()) }).strict()
};

const toolDefinitions = [
  { type: "function" as const, function: { name: "list_files", description: "List files in the workspace.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function" as const, function: { name: "read_file", description: "Read a UTF-8 file in the workspace.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function" as const, function: { name: "write_file", description: "Write a UTF-8 file in the workspace after user confirmation.", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } },
  { type: "function" as const, function: { name: "apply_patch", description: "Apply exact, deterministic text replacements to a workspace file after user confirmation. Each search must match exactly once unless all=true.", parameters: { type: "object", required: ["path", "patches"], properties: { path: { type: "string" }, patches: { type: "array", minItems: 1, items: { type: "object", required: ["search", "replace"], properties: { search: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } }, additionalProperties: false } } }, additionalProperties: false } } },
  { type: "function" as const, function: { name: "run_command", description: "Run a command in the workspace after user confirmation.", parameters: { type: "object", required: ["command", "args"], properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } } } } }
];

const SYSTEM_PROMPT = "You are NoCode, a careful coding agent. Work only in the provided workspace. Explain planned changes briefly. Use tools for repository inspection and edits.";

type ProviderInput = CompletionProvider | ChatCompletionProvider;

export class CodingAgent {
  private readonly complete: CompletionProvider;
  private readonly model: string;
  private readonly context: ConversationContext;

  constructor(
    private readonly tools: WorkspaceTools,
    private readonly confirm: (prompt: string) => Promise<boolean>,
    provider?: ProviderInput,
    options: CodingAgentOptions = {}
  ) {
    if (!provider) {
      const adapter = new OpenAICompletionProvider();
      this.complete = adapter.complete.bind(adapter);
    } else if (typeof provider === "function") {
      this.complete = provider;
    } else {
      this.complete = provider.complete.bind(provider);
    }
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    this.context = new ConversationContext(SYSTEM_PROMPT, {
      maxMessages: options.maxHistoryMessages ?? options.maxMessages,
      summarize: options.summarizeHistory ?? options.summarize
    });
  }

  async run(userInput: string): Promise<string> {
    this.context.add({ role: "user", content: userInput });
    for (let step = 0; step < 8; step += 1) {
      const completion = await this.complete({ model: this.model, messages: await this.context.getMessages(), tools: toolDefinitions, tool_choice: "auto" });
      const message = completion.choices[0]?.message;
      if (!message) return "No response from model.";
      this.context.add(message);
      if (!message.tool_calls?.length) return message.content ?? "(empty response)";
      for (const call of message.tool_calls) {
        let result: ToolResult;
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          result = await this.execute(call.function.name, args);
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        this.context.add({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    return "Stopped after the maximum tool steps.";
  }

  private async execute(name: string, raw: unknown): Promise<ToolResult> {
    if (!Object.hasOwn(schemas, name)) return { ok: false, error: `Unknown tool: ${name}` };
    const schema = schemas[name as keyof typeof schemas];
    const validated = schema.safeParse(raw);
    if (!validated.success) return { ok: false, error: `Invalid arguments for ${name}: ${validated.error.message}` };
    switch (name) {
      case "list_files": return this.tools.listFiles(schemas.list_files.parse(raw).path ?? ".");
      case "read_file": return this.tools.readFile(schemas.read_file.parse(raw).path);
      case "write_file": {
        const args = schemas.write_file.parse(raw);
        if (!await this.confirm(`Write/replace ${JSON.stringify(args.path)} with this content?\n${JSON.stringify(args.content)}`)) return { ok: false, error: "User declined file write" };
        return this.tools.writeFile(args.path, args.content);
      }
      case "apply_patch": {
        const args = schemas.apply_patch.parse(raw) as { path: string; patches: FilePatch[] };
        if (!await this.confirm(`Apply exact text patches to ${JSON.stringify(args.path)}?\n${JSON.stringify(args.patches)}`)) return { ok: false, error: "User declined file patch" };
        return this.tools.applyPatch(args.path, args.patches);
      }
      case "run_command": {
        const args = schemas.run_command.parse(raw);
        if (!await this.confirm(`Run command ${JSON.stringify(args.command)} with arguments ${JSON.stringify(args.args)}? This is not sandboxed and may access files, network, and inherited credentials outside the workspace.`)) return { ok: false, error: "User declined command execution" };
        return this.tools.runCommand(args.command, args.args);
      }
      default: return { ok: false, error: `Unknown tool: ${name}` };
    }
  }
}
