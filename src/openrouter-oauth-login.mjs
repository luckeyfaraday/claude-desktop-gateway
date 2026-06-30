#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultOpenRouterAuthFile } from "./platform-paths.mjs";

const openRouterOrigin = process.env.OPENROUTER_ORIGIN || "https://openrouter.ai";
const authFile = defaultOpenRouterAuthFile();
const callbackHost = process.env.OPENROUTER_OAUTH_HOST || "127.0.0.1";
const callbackPort = Number(process.env.OPENROUTER_OAUTH_PORT || "0");

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function openBrowser(url) {
  const command = process.env.BROWSER;
  const platformCommand =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd.exe"
        : "xdg-open";
  const commandToRun = command || platformCommand;
  const args =
    commandToRun === "cmd.exe"
      ? ["/d", "/s", "/c", `start "" "${url.replaceAll('"', '""')}"`]
      : [url];

  const child = spawn(commandToRun, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

function writeAuthFile(auth) {
  fs.mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(authFile, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(authFile, 0o600);
  } catch {
    // Best effort on platforms that do not support chmod semantics.
  }
}

async function exchangeCode({ code, codeVerifier }) {
  const response = await fetch(`${openRouterOrigin}/api/v1/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: "S256",
    }),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `OpenRouter token exchange failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }

  if (!body || typeof body.key !== "string" || !body.key.trim()) {
    throw new Error(`OpenRouter token exchange returned no key: ${JSON.stringify(body)}`);
  }

  return body;
}

function html(title, body) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 680px; margin: 48px auto; line-height: 1.45;">
${body}
</body>
</html>`;
}

async function main() {
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );

  let finish;
  const finished = new Promise((resolve, reject) => {
    finish = { resolve, reject };
  });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    if (requestUrl.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(html("OpenRouter login failed", `<h1>OpenRouter login failed</h1><p>${error}</p>`));
      finish.reject(new Error(`OpenRouter returned error: ${error}`));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(html("OpenRouter login failed", "<h1>OpenRouter login failed</h1><p>Missing code.</p>"));
      finish.reject(new Error("OpenRouter callback did not include a code."));
      return;
    }

    try {
      const token = await exchangeCode({ code, codeVerifier });
      writeAuthFile({
        key: token.key,
        user_id: token.user_id ?? null,
        created_at: new Date().toISOString(),
        source: "openrouter-oauth-pkce",
      });

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        html(
          "OpenRouter login complete",
          `<h1>OpenRouter login complete</h1><p>You can close this tab and start the gateway.</p><p>Credential saved to <code>${authFile}</code>.</p>`,
        ),
      );
      finish.resolve();
    } catch (err) {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(
        html(
          "OpenRouter login failed",
          `<h1>OpenRouter login failed</h1><pre>${String(err?.message || err)}</pre>`,
        ),
      );
      finish.reject(err);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, callbackHost, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine OAuth callback address.");
  }

  const callbackUrl = `http://${callbackHost}:${address.port}/callback`;
  const authUrl = new URL("/auth", openRouterOrigin);
  authUrl.searchParams.set("callback_url", callbackUrl);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.error("Opening OpenRouter OAuth login in your browser.");
  console.error(`If it does not open, visit:\n${authUrl.toString()}`);
  openBrowser(authUrl.toString());

  try {
    await finished;
    console.error(`Saved OpenRouter OAuth credential to ${authFile}`);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
