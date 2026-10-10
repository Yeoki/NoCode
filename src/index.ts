#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CodingAgent } from "./agent.js";
import { WorkspaceTools } from "./tools.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: nocode [workspace]\nSet OPENAI_API_KEY and optionally OPENAI_MODEL. File writes and commands require confirmation.");
    return;
  }
  const workspace = await fs.realpath(path.resolve(process.argv[2] ?? process.cwd()));
  if (!(await fs.stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory");
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("Set OPENAI_API_KEY before starting NoCode.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | undefined> => {
    process.stdout.write(prompt);
    const line = await lines.next();
    return line.done ? undefined : line.value;
  };
  const agent = new CodingAgent(new WorkspaceTools(workspace), async prompt => {
    // Piped input is never accepted as authorization for mutations or commands.
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    return (await ask(`${prompt} [y/N] `))?.trim().toLowerCase() === "y";
  });
  console.log(`NoCode workspace: ${workspace}`);
  console.log("Type /exit to quit. Approved commands are not sandboxed.");
  try {
    while (true) {
      const line = await ask("\n> ");
      if (line === undefined) break;
      const input = line.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      try { console.log(`\n${await agent.run(input)}`); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    }
  } finally { rl.close(); }
}

main().catch(error => {
  console.error(`NoCode: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
