#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { defaultClaude3pDir } from "../src/platform-paths.mjs";

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
const desktopConfigPath = path.join(claude3pDir, "claude_desktop_config.json");

const desktopConfig = readJson(desktopConfigPath, {});
desktopConfig.deploymentMode = "1p";
writeJson(desktopConfigPath, desktopConfig);

console.log(`Wrote ${desktopConfigPath}`);
console.log("Claude Desktop is set back to its official Anthropic-hosted mode.");
console.log("Quit Claude Desktop completely (including the tray icon) and relaunch it.");
