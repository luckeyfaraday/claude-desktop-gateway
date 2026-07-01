#!/usr/bin/env node

// Local gateway that lets Claude Desktop talk to a running OpenCode server.
//
// Claude Desktop speaks the Anthropic Messages API. OpenCode's local server
// (`opencode serve`) is session-based: you create a session, send a prompt, and
// read results off a live event stream. This bridge translates between the two,
// so OpenCode itself — already logged in and configured with your account,
// providers, and models — does the actual inference. No API keys or provider
// endpoints live here; the model is chosen by OpenCode (optionally pinned via
// OPENCODE_PROVIDER / OPENCODE_MODEL, which the UI sets).

import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createUsageTracker } from "./token-usage.mjs";

const listenHost = process.env.OPENCODE_GATEWAY_HOST || "127.0.0.1";
const listenPort = Number(process.env.OPENCODE_GATEWAY_PORT || "8787");
const serverUrl = (
  process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096"
).replace(/\/+$/, "");
const routeModel = process.env.CLAUDE_ROUTE_MODEL || "claude-sonnet-4-5";
const requestTimeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS || "300000");
const agentName = process.env.OPENCODE_AGENT?.trim() || undefined;

// Provider/model are optional and UI-controlled. Accept either a combined
// "provider/model" in OPENCODE_MODEL or a separate OPENCODE_PROVIDER. When unset,
// OpenCode uses whatever default it is configured with.
function resolveModel() {
  let provider = process.env.OPENCODE_PROVIDER?.trim() || "";
  let model = process.env.OPENCODE_MODEL?.trim() || "";
  if (!provider && model.includes("/")) {
    const idx = model.indexOf("/");
    provider = model.slice(0, idx);
    model = model.slice(idx + 1);
  }
  if (provider && model) return { providerID: provider, id: model };
  return undefined;
}
const pinnedModel = resolveModel();
const modelLabel = pinnedModel
  ? `${pinnedModel.providerID}/${pinnedModel.id}`
  : "(opencode default)";

const usageTracker = createUsageTracker({ label: "OpenCode", model: modelLabel });

class GatewayError extends Error {}

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

function makeMessageId() {
  return `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || "").length / 4));
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Anthropic request -> a single OpenCode prompt.
//
// Claude Desktop resends the full conversation each turn, and we use a fresh
// OpenCode session per request, so we flatten the whole exchange into one prompt.
// ---------------------------------------------------------------------------

function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) =>
        typeof block === "string" ? block : block?.text || "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push(block.text);
    } else if (block.type === "tool_result") {
      const c = block.content;
      if (typeof c === "string") out.push(c);
      else if (Array.isArray(c)) {
        out.push(
          c.map((x) => (x?.type === "text" ? x.text : "")).filter(Boolean).join(""),
        );
      }
    } else if (block.type === "tool_use") {
      out.push(`[tool_use ${block.name}] ${JSON.stringify(block.input ?? {})}`);
    }
    // Images and other block types are dropped in this text bridge.
  }
  return out.join("\n");
}

function buildPrompt(system, messages) {
  const sys = systemText(system).trim();
  const turns = Array.isArray(messages) ? messages : [];
  let convo;
  if (turns.length === 1 && turns[0]?.role === "user") {
    convo = textFromContent(turns[0].content).trim();
  } else {
    const lines = [];
    for (const m of turns) {
      const text = textFromContent(m?.content).trim();
      if (!text) continue;
      lines.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${text}`);
    }
    convo = lines.join("\n\n");
  }
  return [sys, convo].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// OpenCode server calls
// ---------------------------------------------------------------------------

async function createSession(signal) {
  const body = { title: "Claude Desktop" };
  if (pinnedModel) body.model = pinnedModel;
  if (agentName) body.agent = agentName;
  const res = await fetch(`${serverUrl}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new GatewayError(
      `Could not create an OpenCode session (${res.status}): ${await safeText(res)}. ` +
        `Is 'opencode serve' running at ${serverUrl}?`,
    );
  }
  return res.json();
}

async function sendPrompt(sessionID, text, signal) {
  const res = await fetch(
    `${serverUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
      signal,
    },
  );
  if (!res.ok) {
    throw new GatewayError(
      `OpenCode rejected the prompt (${res.status}): ${await safeText(res)}`,
    );
  }
}

async function openEventStream(signal) {
  const res = await fetch(`${serverUrl}/event`, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new GatewayError(`Could not open the OpenCode event stream (${res.status}).`);
  }
  return res.body;
}

function deleteSession(sessionID) {
  fetch(`${serverUrl}/session/${encodeURIComponent(sessionID)}`, {
    method: "DELETE",
  }).catch(() => {});
}

async function processEventStream(body, onEvent, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseFrame(frame);
        if (evt) onEvent(evt);
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader already released
    }
  }
}

function parseFrame(frame) {
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  const body = data.join("\n").trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function usageFromTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return undefined;
  return {
    input_tokens: Number(tokens.input) || 0,
    output_tokens: Number(tokens.output) || 0,
  };
}

function describeError(error) {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  const name = error.name || error.type || "error";
  const message = error.data?.message || error.message || error.data?.responseBody || "";
  return `OpenCode ${name}${message ? `: ${message}` : ""}`;
}

function emitTextPart(part, state, onText) {
  if (!part || part.type !== "text" || part.synthetic || part.ignored) return;
  const text = typeof part.text === "string" ? part.text : "";
  const prev = state.emitted.get(part.id) || 0;
  if (text.length > prev) {
    onText(text.slice(prev));
    state.emitted.set(part.id, text.length);
  }
}

function handleEvent(evt, state, sessionID, onText, finish) {
  if (!evt || typeof evt !== "object") return;
  const p = evt.properties;
  if (!p || p.sessionID !== sessionID) return;

  switch (evt.type) {
    case "message.updated": {
      const info = p.info;
      if (info?.id && info?.role) {
        state.roles.set(info.id, info.role);
        if (info.role === "assistant") {
          const stashed = state.stash.get(info.id);
          if (stashed) {
            for (const part of stashed) emitTextPart(part, state, onText);
            state.stash.delete(info.id);
          }
          if (info.tokens) state.usage = usageFromTokens(info.tokens);
          if (info.error) state.error = describeError(info.error);
        }
      }
      break;
    }
    case "message.part.updated": {
      const part = p.part;
      if (!part || part.type !== "text") break;
      const role = state.roles.get(part.messageID);
      if (role === "assistant") {
        emitTextPart(part, state, onText);
      } else if (role === undefined) {
        // Part arrived before we learned its message's role; hold it until we do.
        const arr = state.stash.get(part.messageID) || [];
        arr.push(part);
        state.stash.set(part.messageID, arr);
      }
      break;
    }
    case "session.error": {
      state.error = describeError(p.error) || "OpenCode session error.";
      state.idled = true;
      finish();
      break;
    }
    case "session.idle": {
      state.idled = true;
      finish();
      break;
    }
    default:
      break;
  }
}

// Safety net: after the session goes idle, re-read the final messages so we emit
// any assistant text that a dropped event might have missed (emitted-length
// tracking prevents duplicates).
async function reconcileFinal(sessionID, state, onText) {
  try {
    const res = await fetch(
      `${serverUrl}/session/${encodeURIComponent(sessionID)}/message`,
    );
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.messages || data.data || [];
    for (const entry of list) {
      const info = entry.info || entry;
      if (!info || info.role !== "assistant") continue;
      if (info.tokens) state.usage = usageFromTokens(info.tokens) || state.usage;
      if (info.id) state.roles.set(info.id, "assistant");
      const parts = entry.parts || [];
      for (const part of Array.isArray(parts) ? parts : []) {
        emitTextPart(part, state, onText);
      }
    }
  } catch {
    // Best effort; the event stream is the primary source.
  }
}

async function driveSession(session, promptText, { signal, onText }) {
  const sessionID = session.id;
  const state = {
    roles: new Map(),
    emitted: new Map(),
    stash: new Map(),
    usage: undefined,
    error: undefined,
    idled: false,
  };

  const eventsAbort = new AbortController();
  const onAbort = () => eventsAbort.abort();
  if (signal) {
    if (signal.aborted) eventsAbort.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => resolveDone();

  // Subscribe before sending the prompt so no generation events are missed.
  const body = await openEventStream(eventsAbort.signal);
  const streaming = processEventStream(
    body,
    (evt) => handleEvent(evt, state, sessionID, onText, finish),
    eventsAbort.signal,
  ).catch((error) => {
    if (!state.error && !eventsAbort.signal.aborted) {
      state.error = `OpenCode event stream error: ${error?.message || error}`;
    }
    finish();
  });

  try {
    await sendPrompt(sessionID, promptText, signal);
    await done;
    await reconcileFinal(sessionID, state, onText);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    eventsAbort.abort();
    await streaming.catch(() => {});
    deleteSession(sessionID);
  }

  if (!state.idled && signal?.aborted) {
    throw new GatewayError(
      `OpenCode request timed out after ${requestTimeoutMs}ms.`,
    );
  }
  if (state.error) throw new GatewayError(state.error);
  return { usage: state.usage };
}

// ---------------------------------------------------------------------------
// Anthropic SSE helpers
// ---------------------------------------------------------------------------

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
}

async function handleMessages(req, res) {
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

  const promptText = buildPrompt(payload.system, payload.messages);
  if (!promptText.trim()) {
    json(res, 400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "No text content found in the request.",
      },
    });
    return;
  }

  const stream = payload.stream === true;
  const inputTokens = estimateTokens(promptText);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    // Pre-flight session creation while we can still return a clean HTTP error.
    const session = await createSession(controller.signal);
    let out = "";

    if (stream) {
      writeSseHead(res);
      const messageId = makeMessageId();
      sseSend(res, "message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: routeModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      });
      sseSend(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      sseSend(res, "ping", { type: "ping" });

      const result = await driveSession(session, promptText, {
        signal: controller.signal,
        onText: (text) => {
          out += text;
          sseSend(res, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          });
        },
      });

      sseSend(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sseSend(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: result.usage?.output_tokens || estimateTokens(out) },
      });
      sseSend(res, "message_stop", { type: "message_stop" });
      res.end();
      usageTracker.record(
        result.usage || { input_tokens: inputTokens, output_tokens: estimateTokens(out) },
      );
      return;
    }

    const result = await driveSession(session, promptText, {
      signal: controller.signal,
      onText: (text) => {
        out += text;
      },
    });
    const usage = result.usage || {
      input_tokens: inputTokens,
      output_tokens: estimateTokens(out),
    };
    usageTracker.record(usage);
    json(res, 200, {
      id: makeMessageId(),
      type: "message",
      role: "assistant",
      model: routeModel,
      content: [{ type: "text", text: out }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    });
  } catch (error) {
    const aborted = controller.signal.aborted || error?.name === "AbortError";
    const message = aborted
      ? `OpenCode request timed out after ${requestTimeoutMs}ms.`
      : error instanceof GatewayError
        ? error.message
        : `OpenCode request failed: ${error?.message || String(error)}`;
    const type = aborted ? "timeout_error" : "api_error";
    if (res.headersSent) {
      try {
        sseSend(res, "error", { type: "error", error: { type, message } });
        sseSend(res, "message_stop", { type: "message_stop" });
        res.end();
      } catch {
        try {
          res.end();
        } catch {
          // socket already gone
        }
      }
    } else {
      json(res, aborted ? 504 : 502, { type: "error", error: { type, message } });
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function handleCountTokens(req, res) {
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
  json(res, 200, {
    input_tokens: estimateTokens(buildPrompt(payload.system, payload.messages)),
  });
}

function handleModels(res) {
  json(res, 200, {
    object: "list",
    data: [
      {
        id: routeModel,
        type: "model",
        display_name: `${routeModel} via OpenCode (${modelLabel})`,
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
      provider: "opencode",
      serverUrl,
      model: modelLabel,
      routeModel,
      usage: usageTracker.snapshot(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    handleModels(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    await handleCountTokens(req, res);
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
  console.error(`OpenCode gateway listening on http://${listenHost}:${listenPort}`);
  console.error(`OpenCode server: ${serverUrl}`);
  console.error(`Model: ${modelLabel}`);
  console.error(`Route model: ${routeModel}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await delay(25);
    process.exit(0);
  });
}
