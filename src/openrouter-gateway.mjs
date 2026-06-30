#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { defaultOpenRouterAuthFile } from "./platform-paths.mjs";

const listenHost = process.env.OPENROUTER_GATEWAY_HOST || "127.0.0.1";
const listenPort = Number(process.env.OPENROUTER_GATEWAY_PORT || "8787");
const openRouterBaseUrl = (
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api"
).replace(/\/+$/, "");
const upstreamModel =
  process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";
const routeModel = process.env.CLAUDE_ROUTE_MODEL || "claude-sonnet-4-5";
const requestTimeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || "300000");
const authFile = defaultOpenRouterAuthFile();

function loadOpenRouterApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

  try {
    const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (typeof auth.key === "string" && auth.key.trim()) return auth.key.trim();
  } catch {
    // Missing or invalid auth files are reported as a normal configuration error below.
  }

  return undefined;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function copyHeader(headers, name, value) {
  if (value !== undefined && value !== null && value !== "") {
    headers[name] = value;
  }
}

function responseHeaders(upstream) {
  const headers = {};
  for (const name of [
    "content-type",
    "cache-control",
    "x-request-id",
    "openrouter-processing-ms",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function pipeWebStreamToNode(webStream, nodeStream) {
  if (!webStream) {
    nodeStream.end();
    return;
  }

  const reader = webStream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!nodeStream.write(Buffer.from(value))) {
        await new Promise((resolve) => nodeStream.once("drain", resolve));
      }
    }
  } finally {
    reader.releaseLock();
    nodeStream.end();
  }
}

async function handleMessages(req, res) {
  const apiKey = loadOpenRouterApiKey();
  if (!apiKey) {
    json(res, 500, {
      type: "error",
      error: {
        type: "configuration_error",
        message:
          "No OpenRouter credential found. Run npm run login or set OPENROUTER_API_KEY.",
      },
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    json(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON body." },
    });
    return;
  }

  const originalModel = payload.model;
  payload.model = upstreamModel;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "anthropic-version":
      req.headers["anthropic-version"]?.toString() || "2023-06-01",
    "x-title": "claude-desktop-shim",
  };

  copyHeader(headers, "anthropic-beta", req.headers["anthropic-beta"]);
  copyHeader(headers, "http-referer", process.env.OPENROUTER_HTTP_REFERER);
  copyHeader(headers, "x-title", process.env.OPENROUTER_APP_TITLE);

  try {
    const upstream = await fetch(`${openRouterBaseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const outHeaders = responseHeaders(upstream);
    outHeaders["x-claude-desktop-shim-model"] = upstreamModel;
    if (originalModel) outHeaders["x-claude-desktop-shim-route-model"] = originalModel;

    res.writeHead(upstream.status, outHeaders);
    await pipeWebStreamToNode(upstream.body, res);
  } catch (error) {
    if (!res.headersSent) {
      const aborted = error?.name === "AbortError";
      json(res, aborted ? 504 : 502, {
        type: "error",
        error: {
          type: aborted ? "timeout_error" : "upstream_error",
          message: aborted
            ? `OpenRouter request timed out after ${requestTimeoutMs}ms.`
            : `OpenRouter request failed: ${error?.message || String(error)}`,
        },
      });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
  }
}

function handleModels(res) {
  json(res, 200, {
    object: "list",
    data: [
      {
        id: routeModel,
        type: "model",
        display_name: `${routeModel} via OpenRouter (${upstreamModel})`,
        created_at: 0,
      },
    ],
    has_more: false,
    first_id: routeModel,
    last_id: routeModel,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      routeModel,
      upstreamModel,
      openRouterBaseUrl,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    handleModels(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    await handleMessages(req, res);
    return;
  }

  json(res, 404, {
    type: "error",
    error: { type: "not_found_error", message: "Route not found." },
  });
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(listenPort, listenHost, () => {
  console.error(
    `OpenRouter gateway listening on http://${listenHost}:${listenPort}`,
  );
  console.error(`Route model: ${routeModel}`);
  console.error(`OpenRouter model: ${upstreamModel}`);
  console.error(
    process.env.OPENROUTER_API_KEY
      ? "OpenRouter auth: OPENROUTER_API_KEY"
      : `OpenRouter auth: ${authFile}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await delay(25);
    process.exit(0);
  });
}
