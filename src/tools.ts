import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
export type ToolResult = { ok: true; output: string } | { ok: false; error: string };
const failure = (error: unknown): ToolResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export class WorkspaceTools {
  private readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  // Reject symlinks, including dangling links and existing ancestors of new files.
  // This is a filesystem guard, not isolation against concurrent hostile changes.
  private async resolve(relativePath: string): Promise<string> {
    if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) throw new Error("Invalid path");
    const root = await fs.realpath(this.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace must be a directory");
    const absolute = path.resolve(root, relativePath);
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path escapes the workspace");
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not allowed in file tool paths");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return absolute;
  }

  async listFiles(relativePath = "."): Promise<ToolResult> {
    try {
      const entries = await fs.readdir(await this.resolve(relativePath), { withFileTypes: true });
      return { ok: true, output: entries.map((e) => `${e.isSymbolicLink() ? "l" : e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n") };
    } catch (error) { return failure(error); }
  }

  async readFile(relativePath: string): Promise<ToolResult> {
    try {
      const handle = await fs.open(await this.resolve(relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) throw new Error("Path must be a regular file");
        return { ok: true, output: await handle.readFile("utf8") };
      } finally { await handle.close(); }
    } catch (error) { return failure(error); }
  }

  async writeFile(relativePath: string, content: string): Promise<ToolResult> {
    let temporary: string | undefined;
    try {
      if (typeof content !== "string") throw new Error("Content must be a string");
      const filename = await this.resolve(relativePath);
      let mode: number | undefined;
      try {
        const stat = await fs.lstat(filename);
        if (!stat.isFile()) throw new Error("Path must be a regular file");
        mode = stat.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await this.resolve(relativePath);
      // Replace the directory entry rather than mutating a potentially hard-linked inode.
      temporary = path.join(path.dirname(filename), `.nocode-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: mode ?? 0o600 });
      await this.resolve(relativePath);
      await fs.rename(temporary, filename);
      temporary = undefined;
      return { ok: true, output: `Wrote ${relativePath}` };
    } catch (error) { return failure(error); }
    finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async runCommand(command: string, args: string[]): Promise<ToolResult> {
    try {
      if (typeof command !== "string" || !command.trim() || command.includes("\0") || !Array.isArray(args) || args.some(a => typeof a !== "string" || a.includes("\0"))) throw new Error("Invalid command arguments");
      const { stdout, stderr } = await execFileAsync(command, args, { cwd: await this.resolve("."), timeout: 30_000, maxBuffer: 1_000_000 });
      return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n") || "(no output)" };
    } catch (error) {
      const e = error as { message?: string; stdout?: string; stderr?: string };
      return { ok: false, error: [e.message, e.stdout, e.stderr].filter(Boolean).join("\n") };
    }
  }
}
