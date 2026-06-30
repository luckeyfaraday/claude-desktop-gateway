#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultClaude3pDir } from "../src/platform-paths.mjs";

const gatewayHost = process.env.OPENROUTER_GATEWAY_HOST || "127.0.0.1";
const gatewayPort = process.env.OPENROUTER_GATEWAY_PORT || "8787";
const routeModel = process.env.CLAUDE_ROUTE_MODEL || "claude-sonnet-4-5";
const upstreamModel =
  process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

const claude3pDir = defaultClaude3pDir();
const configLibrary = path.join(claude3pDir, "configLibrary");
const desktopConfigPath = path.join(claude3pDir, "claude_desktop_config.json");
const metaPath = path.join(configLibrary, "_meta.json");
const id = crypto.randomUUID();
const gatewayBaseUrl = `http://${gatewayHost}:${gatewayPort}`;

fs.mkdirSync(configLibrary, { recursive: true, mode: 0o700 });

const desktopConfig = readJson(desktopConfigPath, {});
desktopConfig.deploymentMode = "3p";
desktopConfig.awaitingSignIn = false;
writeJson(desktopConfigPath, desktopConfig);

const config = {
  inferenceProvider: "gateway",
  inferenceGatewayBaseUrl: gatewayBaseUrl,
  inferenceGatewayAuthScheme: "bearer",
  inferenceGatewayApiKey: "local-openrouter-gateway",
  inferenceCredentialKind: "static",
  inferenceModels: [routeModel],
};

const configPath = path.join(configLibrary, `${id}.json`);
writeJson(configPath, config);
writeJson(metaPath, { appliedId: id });

console.log(`Wrote ${desktopConfigPath}`);
console.log(`Wrote ${configPath}`);
console.log(`Wrote ${metaPath}`);
console.log(`Claude route model: ${routeModel}`);
console.log(`OpenRouter upstream model: ${upstreamModel}`);
console.log(`Gateway base URL: ${gatewayBaseUrl}`);
console.log("");
console.log("Start the gateway before launching Claude Desktop:");
console.log("  npm run gateway");
