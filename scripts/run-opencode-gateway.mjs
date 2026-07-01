#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultOpenCodeAuthFile } from "../src/platform-paths.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const authFile = defaultOpenCodeAuthFile();

function setDefaultEnv(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function hasStoredCredential(file) {
  try {
    const auth = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof auth.access_token === "string" && auth.access_token.trim() !== "";
  } catch {
    return false;
  }
}

if (!process.env.OPENCODE_ACCESS_TOKEN && !hasStoredCredential(authFile)) {
  console.error("No OpenCode OAuth credential found. Starting OpenCode login...");
  await import(pathToFileURL(path.join(rootDir, "src", "opencode-oauth-login.mjs")).href);
}

setDefaultEnv("OPENCODE_PROVIDER", "opencode");
setDefaultEnv("CLAUDE_ROUTE_MODEL", "claude-sonnet-4-5");
setDefaultEnv("OPENCODE_GATEWAY_HOST", "127.0.0.1");
setDefaultEnv("OPENCODE_GATEWAY_PORT", "8787");

await import(pathToFileURL(path.join(rootDir, "src", "opencode-oauth-gateway.mjs")).href);
