#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parse } from "smol-toml";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: with-codex-api-key.mjs <command> [args ...]");
  process.exit(2);
}

async function resolveApiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();

  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  let auth;
  try {
    auth = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    throw new Error(`OPENAI_API_KEY is not set and Codex auth could not be read from ${authPath}`);
  }

  if (auth?.auth_mode !== "apikey" || typeof auth.OPENAI_API_KEY !== "string" || !auth.OPENAI_API_KEY.trim()) {
    throw new Error("OPENAI_API_KEY is not set and Codex is not using API-key authentication; configure a Platform API key explicitly.");
  }
  return auth.OPENAI_API_KEY.trim();
}

async function applyCodexEndpointIfRequested(environment) {
  if (environment.NOCODE_REUSE_CODEX_ENDPOINT !== "1") return environment;
  const codexHome = environment.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  let config;
  try {
    config = parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(`NOCODE_REUSE_CODEX_ENDPOINT=1 was set, but Codex config could not be read or parsed from ${configPath}`);
  }
  const readString = (table, key) => typeof table?.[key] === "string" ? table[key].trim() || undefined : undefined;
  const providerName = readString(config, "model_provider") ?? "openai";
  const provider = providerName === "openai"
    ? { base_url: readString(config, "openai_base_url") ?? "https://api.openai.com/v1", wire_api: "responses" }
    : Object.hasOwn(config.model_providers ?? {}, providerName) ? config.model_providers[providerName] : undefined;
  if (!provider) throw new Error(`Selected model provider ${JSON.stringify(providerName)} is missing from ${configPath}`);
  const baseURL = environment.OPENAI_BASE_URL?.trim() || readString(provider, "base_url");
  if (!baseURL) throw new Error(`base_url is missing for the selected model provider ${JSON.stringify(providerName)} in ${configPath}`);
  return {
    ...environment,
    OPENAI_BASE_URL: baseURL,
    OPENAI_WIRE_API: environment.OPENAI_WIRE_API?.trim() || readString(provider, "wire_api") || "responses",
    OPENAI_MODEL: environment.OPENAI_MODEL?.trim() || readString(config, "model") || "gpt-4.1-mini"
  };
}

let apiKey;
try {
  apiKey = await resolveApiKey();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let childEnvironment;
try {
  childEnvironment = await applyCodexEndpointIfRequested({ ...process.env, OPENAI_API_KEY: apiKey });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Failed to start ${command}: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
