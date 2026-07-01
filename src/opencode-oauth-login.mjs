#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { defaultOpenCodeAuthFile } from "./platform-paths.mjs";

const authFile = defaultOpenCodeAuthFile();
const openCodeOrigin = (process.env.OPENCODE_CONSOLE_URL || "https://console.opencode.ai").replace(
  /\/+$/,
  "",
);
const clientId = process.env.OPENCODE_OAUTH_CLIENT_ID || "opencode-cli";

function writeAuthFile(auth) {
  fs.mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(authFile, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(authFile, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support POSIX modes.
  }
}

function openBrowser(url) {
  const platform = os.platform();
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args =
    platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = execFile(command, args, { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function postJson(url, body, { allowErrorBody = false } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "claude-desktop-shim",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok && !allowErrorBody) {
    const message = payload?.error_description || payload?.error || payload?._tag || text;
    throw new Error(`OpenCode OAuth request failed (${response.status}): ${message}`);
  }
  return payload;
}

async function pollForToken(deviceCode, intervalSeconds) {
  let intervalMs = Math.max(Number(intervalSeconds) || 5, 1) * 1000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const result = await postJson(
      `${openCodeOrigin}/auth/device/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
      },
      { allowErrorBody: true },
    );
    if (typeof result.access_token === "string" && typeof result.refresh_token === "string") {
      return result;
    }
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`OpenCode device authorization failed: ${result.error || "unknown error"}`);
  }
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "claude-desktop-shim",
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || payload?._tag || text;
    throw new Error(`OpenCode account lookup failed (${response.status}): ${message}`);
  }
  return payload;
}

async function main() {
  const device = await postJson(`${openCodeOrigin}/auth/device/code`, {
    client_id: clientId,
  });

  const url = `${openCodeOrigin}${device.verification_uri_complete}`;
  console.error("OpenCode login");
  console.error(`Open this URL if your browser does not open automatically:\n${url}`);
  if (device.user_code) console.error(`Code: ${device.user_code}`);
  openBrowser(url);

  const token = await pollForToken(device.device_code, device.interval);
  const [user, orgs] = await Promise.all([
    fetchJson(`${openCodeOrigin}/api/user`, token.access_token),
    fetchJson(`${openCodeOrigin}/api/orgs`, token.access_token).catch(() => []),
  ]);
  const org = Array.isArray(orgs)
    ? orgs.toSorted((a, b) => String(a.name || "").localeCompare(String(b.name || "")))[0]
    : undefined;

  writeAuthFile({
    source: "opencode-console-oauth",
    server: openCodeOrigin,
    client_id: clientId,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
    account_id: user?.id,
    email: user?.email,
    org_id: org?.id,
    org_name: org?.name,
  });

  console.error(`Saved OpenCode OAuth credential to ${authFile}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
