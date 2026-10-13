import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
export type ToolResult = { ok: true; output: string } | { ok: false; error: string };

/** A deterministic, structured replacement applied to one workspace file. */
export type FilePatch = {
  search: string;
  replace: string;
  /** Replace every match instead of requiring exactly one match. */
  all?: boolean;
};
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

  /**
   * Apply exact text replacements to a regular file and atomically write the result.
   *
   * Replacements are intentionally structured rather than shell-like patches: every
   * search string must match, and by default it must match exactly once. This keeps
   * edits deterministic and prevents silently changing the wrong location.
   */
  async applyPatch(relativePath: string, patches: FilePatch[]): Promise<ToolResult> {
    try {
      if (!Array.isArray(patches) || patches.length === 0) throw new Error("At least one patch is required");
      for (const patch of patches) {
        if (!patch || typeof patch.search !== "string" || patch.search.length === 0 || typeof patch.replace !== "string" || (patch.all !== undefined && typeof patch.all !== "boolean")) {
          throw new Error("Each patch must include a non-empty search string and a string replacement");
        }
      }
      const target = await this.resolve(relativePath);
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        if (!(await handle.stat()).isFile()) throw new Error("Path must be a regular file");
        content = await handle.readFile("utf8");
      } finally { await handle.close(); }

      for (const [index, patch] of patches.entries()) {
        const matches = content.split(patch.search).length - 1;
        if (matches === 0) throw new Error(`Patch ${index + 1} did not match any text`);
        if (!patch.all && matches !== 1) throw new Error(`Patch ${index + 1} matched ${matches} locations; set all=true to replace all matches`);
        // Use a replacer callback so `$&` and friends in user text stay literal.
        content = patch.all ? content.split(patch.search).join(patch.replace) : content.replace(patch.search, () => patch.replace);
      }
      return this.writeFile(relativePath, content);
    } catch (error) { return failure(error); }
  }

  // Alias kept for callers that prefer the noun form.
  async patchFile(relativePath: string, patches: FilePatch[]): Promise<ToolResult> {
    return this.applyPatch(relativePath, patches);
  }

  async runCommand(command: string, args: string[]): Promise<ToolResult> {
    try {
      if (typeof command !== "string" || !command.trim() || command.includes("\0") || !Array.isArray(args) || args.some(a => typeof a !== "string" || a.includes("\0"))) throw new Error("Invalid command arguments");
      const { OPENAI_API_KEY: _openAiApiKey, CODEX_API_KEY: _codexApiKey, ...commandEnvironment } = process.env;
      const { stdout, stderr } = await execFileAsync(command, args, { cwd: await this.resolve("."), env: commandEnvironment, timeout: 30_000, maxBuffer: 1_000_000 });
      return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n") || "(no output)" };
    } catch (error) {
      const e = error as { message?: string; stdout?: string; stderr?: string };
      return { ok: false, error: [e.message, e.stdout, e.stderr].filter(Boolean).join("\n") };
    }
  }
}
