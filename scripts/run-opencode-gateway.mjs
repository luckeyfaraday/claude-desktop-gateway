#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

function setDefaultEnv(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

// OpenCode signs into the ChatGPT/Codex backend with OpenAI's official OAuth
// client, so it reuses the exact Codex Responses pipeline — this wrapper just
// pins the credential source to OpenCode's auth.json.
setDefaultEnv("CODEX_OAUTH_SOURCE", "opencode");
setDefaultEnv("CODEX_MODEL", "gpt-5.5");
setDefaultEnv("CLAUDE_ROUTE_MODEL", "claude-sonnet-4-5");
setDefaultEnv("CODEX_GATEWAY_HOST", "127.0.0.1");
setDefaultEnv("CODEX_GATEWAY_PORT", "8787");

await import(pathToFileURL(path.join(rootDir, "src", "codex-oauth-gateway.mjs")).href);
