import { promises as fs } from "node:fs";
import path from "node:path";
import type OpenAI from "openai";

export interface SessionSnapshot {
  version: 1;
  sessionId: string;
  updatedAt: string;
  wireApi: "chat" | "responses";
  chatMessages?: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  responseItems?: OpenAI.Responses.ResponseInput;
}

/** Small atomic JSON store for resumable, workspace-local session memory. */
export class JsonSessionStore {
  constructor(private readonly filePath: string) {}

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return undefined;
      const value = parsed as Partial<SessionSnapshot>;
      if (value.version !== 1 || value.sessionId !== sessionId || (value.wireApi !== "chat" && value.wireApi !== "responses")) return undefined;
      return value as SessionSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}
