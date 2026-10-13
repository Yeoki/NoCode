#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentEvent, CodingAgent } from "./agent.js";
import { WorkspaceTools } from "./tools.js";

/**
 * Render lifecycle events without printing model reasoning.  stderr is used
 * so the assistant's final answer on stdout remains pipe-friendly.
 */
function createProgressRenderer(): (event: AgentEvent) => void {
  let spinner: NodeJS.Timeout | undefined;
  let frame = 0;
  const frames = ["|", "/", "-", "\\"];
  const isInteractive = Boolean(process.stderr.isTTY);
  const stopSpinner = (): void => {
    if (spinner) clearInterval(spinner);
    spinner = undefined;
    if (isInteractive) process.stderr.write("\r\x1b[2K");
  };
  const status = (message: string): void => {
    if (isInteractive) process.stderr.write(`${message}\n`);
    else process.stderr.write(`[NoCode] ${message}\n`);
  };
  const startThinking = (step: number): void => {
    stopSpinner();
    if (!isInteractive) { status(`thinking (step ${step})...`); return; }
    frame = 0;
    const draw = (): void => { process.stderr.write(`\r${frames[frame++ % frames.length]} thinking (step ${step})...`); };
    draw();
    spinner = setInterval(draw, 250);
  };
  const summarize = (event: Extract<AgentEvent, { type: "tool_result" }>): string => {
    const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f\u001b]/g, " ").trim();
    if (!event.result.ok) {
      const error = clean(event.result.error);
      return `error: ${error.length > 120 ? `${error.slice(0, 117)}...` : error}`;
    }
    // Tool output can contain arbitrary bytes; do not let it inject terminal
    // control sequences into the progress renderer.
    const firstLine = (event.result.output.split(/\r?\n/, 1)[0] ?? "")
      .replace(/[\u0000-\u001f\u007f\u001b]/g, " ")
      .trim();
    const preview = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
    return preview ? `ok (${preview})` : "ok";
  };
  return event => {
    switch (event.type) {
      case "thinking": startThinking(event.step); break;
      case "response":
        stopSpinner();
        if (event.toolCalls > 0) status(`model requested ${event.toolCalls} tool${event.toolCalls === 1 ? "" : "s"}`);
        break;
      case "tool_start":
        stopSpinner();
        status(`tool: ${event.name}`);
        break;
      case "tool_result":
        stopSpinner();
        status(`tool result (${event.name}): ${summarize(event)}`);
        break;
      case "stopped":
        stopSpinner();
        status(`stopped: ${event.reason}`);
        break;
      case "error":
        stopSpinner();
        break;
      case "final":
        stopSpinner();
        break;
    }
  };
}

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
  }, undefined, { onEvent: createProgressRenderer() });
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
