import OpenAI from "openai";
import { z } from "zod";
import { WorkspaceTools, ToolResult } from "./tools.js";

export type CompletionProvider = (request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => Promise<Pick<OpenAI.Chat.Completions.ChatCompletion, "choices">>;
const schemas = {
  list_files: z.object({ path: z.string().min(1).optional() }).strict(),
  read_file: z.object({ path: z.string().min(1) }).strict(),
  write_file: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  run_command: z.object({ command: z.string().trim().min(1), args: z.array(z.string()) }).strict()
};

const toolDefinitions = [
  { type: "function" as const, function: { name: "list_files", description: "List files in the workspace.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function" as const, function: { name: "read_file", description: "Read a UTF-8 file in the workspace.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function" as const, function: { name: "write_file", description: "Write a UTF-8 file in the workspace after user confirmation.", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } },
  { type: "function" as const, function: { name: "run_command", description: "Run a command in the workspace after user confirmation.", parameters: { type: "object", required: ["command", "args"], properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } } } } }
];

export class CodingAgent {
  private readonly complete: CompletionProvider;
  private readonly model: string;
  private readonly history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(private readonly tools: WorkspaceTools, private readonly confirm: (prompt: string) => Promise<boolean>, complete?: CompletionProvider) {
    this.complete = complete ?? ((client => request => client.chat.completions.create(request))(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })));
    this.model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    this.history.push({ role: "system", content: "You are NoCode, a careful coding agent. Work only in the provided workspace. Explain planned changes briefly. Use tools for repository inspection and edits." });
  }

  async run(userInput: string): Promise<string> {
    this.history.push({ role: "user", content: userInput });
    for (let step = 0; step < 8; step += 1) {
      const completion = await this.complete({ model: this.model, messages: this.history, tools: toolDefinitions, tool_choice: "auto" });
      const message = completion.choices[0]?.message;
      if (!message) return "No response from model.";
      this.history.push(message);
      if (!message.tool_calls?.length) return message.content ?? "(empty response)";
      for (const call of message.tool_calls) {
        let result: ToolResult;
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          result = await this.execute(call.function.name, args);
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        this.history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
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
      case "run_command": {
        const args = schemas.run_command.parse(raw);
        if (!await this.confirm(`Run command ${JSON.stringify(args.command)} with arguments ${JSON.stringify(args.args)}? This is not sandboxed and may access files, network, and inherited credentials outside the workspace.`)) return { ok: false, error: "User declined command execution" };
        return this.tools.runCommand(args.command, args.args);
      }
      default: return { ok: false, error: `Unknown tool: ${name}` };
    }
  }
}
