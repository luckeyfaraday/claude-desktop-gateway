#!/usr/bin/env node

// Starts (or reuses) a local OpenCode server, then launches the gateway that
// bridges Claude Desktop to it. OpenCode holds all account/provider/model auth;
// this script just makes sure `opencode serve` is up before the gateway starts.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

function setDefaultEnv(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

setDefaultEnv("CLAUDE_ROUTE_MODEL", "claude-sonnet-4-5");
setDefaultEnv("OPENCODE_GATEWAY_HOST", "127.0.0.1");
setDefaultEnv("OPENCODE_GATEWAY_PORT", "8787");

let child;

function shutdown() {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/global/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`OpenCode server at ${url} did not become ready in time.`);
    }
    await delay(300);
  }
}

async function ensureServer() {
  if (process.env.OPENCODE_SERVER_URL) {
    console.error(`Using existing OpenCode server: ${process.env.OPENCODE_SERVER_URL}`);
    return;
  }

  const host = process.env.OPENCODE_SERVER_HOST || "127.0.0.1";
  const port = process.env.OPENCODE_SERVER_PORT || "4096";
  const url = `http://${host}:${port}`;
  const bin = process.env.OPENCODE_BIN || "opencode";

  console.error(`Starting OpenCode server: ${bin} serve --port ${port} --hostname ${host}`);
  child = spawn(bin, ["serve", "--port", String(port), "--hostname", host], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  child.on("error", (error) => {
    console.error(
      `Failed to start '${bin}': ${error.message}. ` +
        `Install OpenCode (https://opencode.ai) or set OPENCODE_SERVER_URL to an existing server.`,
    );
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`OpenCode server exited with code ${code}.`);
  });

  const timeoutMs = Number(process.env.OPENCODE_SERVER_TIMEOUT_MS || "30000");
  await waitForServer(url, timeoutMs);
  process.env.OPENCODE_SERVER_URL = url;
  console.error(`OpenCode server ready: ${url}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}
process.on("exit", shutdown);

await ensureServer();
await import(pathToFileURL(path.join(rootDir, "src", "opencode-gateway.mjs")).href);
