#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultOpenRouterAuthFile } from "../src/platform-paths.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const authFile = defaultOpenRouterAuthFile();

function setDefaultEnv(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function hasStoredCredential(file) {
  try {
    const auth = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof auth.key === "string" && auth.key.trim() !== "";
  } catch {
    return false;
  }
}

if (!process.env.OPENROUTER_API_KEY && !hasStoredCredential(authFile)) {
  console.error("No OpenRouter credential found. Starting OAuth login...");
  await import(
    pathToFileURL(path.join(rootDir, "src", "openrouter-oauth-login.mjs")).href
  );
}

setDefaultEnv("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5");
setDefaultEnv("CLAUDE_ROUTE_MODEL", "claude-sonnet-4-5");
setDefaultEnv("OPENROUTER_GATEWAY_HOST", "127.0.0.1");
setDefaultEnv("OPENROUTER_GATEWAY_PORT", "8787");

await import(
  pathToFileURL(path.join(rootDir, "src", "openrouter-gateway.mjs")).href
);
