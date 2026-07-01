#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultOpenCodeAuthFile } from "./platform-paths.mjs";
import {
  createUsageTracker,
  normalizeUsage,
  usageFromPayload,
} from "./token-usage.mjs";

const listenHost = process.env.OPENCODE_GATEWAY_HOST || "127.0.0.1";
const listenPort = Number(process.env.OPENCODE_GATEWAY_PORT || "8787");
const openCodeOrigin = (process.env.OPENCODE_CONSOLE_URL || "https://console.opencode.ai").replace(
  /\/+$/,
  "",
);
const clientId = process.env.OPENCODE_OAUTH_CLIENT_ID || "opencode-cli";
const providerId = process.env.OPENCODE_PROVIDER || "opencode";
const upstreamModel = process.env.OPENCODE_MODEL || "";
const routeModel = process.env.CLAUDE_ROUTE_MODEL || "claude-sonnet-4-5";
const requestTimeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS || "300000");
const refreshSkewMs = Number(process.env.OPENCODE_REFRESH_SKEW_MS || "120000");
const authFile = defaultOpenCodeAuthFile();
const usageTracker = createUsageTracker({
  label: "OpenCode",
  model: upstreamModel || "auto",
});

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonFile(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support POSIX modes.
  }
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

async function postOpenCode(pathname, body, schemaName = "request") {
  const response = await fetch(`${openCodeOrigin}${pathname}`, {
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
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || payload?._tag || text;
    throw new Error(`OpenCode ${schemaName} failed (${response.status}): ${message}`);
  }
  return payload;
}

async function refreshCredential(credential) {
  if (!credential?.refresh_token) throw new Error("OpenCode credential has no refresh_token.");
  const token = await postOpenCode(
    "/auth/device/token",
    {
      grant_type: "refresh_token",
      refresh_token: credential.refresh_token,
      client_id: credential.client_id || clientId,
    },
    "token refresh",
  );
  if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
    throw new Error("OpenCode token refresh response was missing tokens.");
  }
  const next = {
    ...credential,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  writeJsonFile(authFile, next);
  return next;
}

async function resolveCredential() {
  const envToken = process.env.OPENCODE_ACCESS_TOKEN;
  if (envToken?.trim()) {
    return {
      accessToken: envToken.trim(),
      orgId: process.env.OPENCODE_ORG_ID,
      source: "OPENCODE_ACCESS_TOKEN",
    };
  }

  const credential = readJsonFile(authFile);
  if (!credential?.access_token) {
    throw new Error("No OpenCode OAuth credential found. Run npm run login:opencode.");
  }
  const expiresAt = Number(credential.expires_at || 0);
  const usable =
    !Number.isFinite(expiresAt) || expiresAt === 0 || expiresAt > Date.now() + refreshSkewMs;
  const next = usable ? credential : await refreshCredential(credential);
  return {
    accessToken: String(next.access_token).trim(),
    orgId: next.org_id,
    source: usable ? authFile : `${authFile} refreshed`,
  };
}

async function fetchRemoteConfig(credential) {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${credential.accessToken}`,
    "user-agent": "claude-desktop-shim",
  };
  if (credential.orgId) headers["x-org-id"] = credential.orgId;
  const response = await fetch(`${openCodeOrigin}/api/config`, { headers });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || payload?._tag || text;
    throw new Error(`OpenCode config lookup failed (${response.status}): ${message}`);
  }
  return payload?.config || payload;
}

function withoutCredentialOptions(options = {}) {
  const next = { ...options };
  delete next.apiKey;
  delete next.headers;
  return next;
}

function selectedUpstream(config) {
  const providers = config?.provider || {};
  const provider = providers[providerId] || providers[Object.keys(providers)[0]];
  const resolvedProviderId = providers[providerId] ? providerId : Object.keys(providers)[0];
  if (!provider) {
    throw new Error(`OpenCode config did not include any providers.`);
  }

  const models = provider.models || {};
  const modelId = upstreamModel || Object.keys(models)[0];
  const model = models[modelId];
  if (!model) {
    throw new Error(
      `OpenCode provider ${resolvedProviderId} does not include model ${modelId || "(none)"}.`,
    );
  }

  const modelProvider = model.provider || {};
  const baseUrl = (
    process.env.OPENCODE_BASE_URL ||
    modelProvider.api ||
    provider.api ||
    "https://api.opencode.ai/v1"
  ).replace(/\/+$/, "");
  return {
    providerId: resolvedProviderId,
    modelId,
    apiModel: model.id || modelId,
    baseUrl,
    headers: {
      ...(provider.options?.headers || {}),
      ...(model.headers || {}),
    },
    body: {
      ...withoutCredentialOptions(provider.options),
      ...withoutCredentialOptions(model.options),
    },
  };
}

function copyHeader(headers, name, value) {
  if (value !== undefined && value !== null && value !== "") headers[name] = value;
}

function flattenAnthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function anthropicContentToOpenAi(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part?.type === "image" && part.source?.type === "url") {
      parts.push({ type: "image_url", image_url: { url: part.source.url } });
      continue;
    }
    if (part?.type === "image" && part.source?.type === "base64") {
      const mediaType = part.source.media_type || "image/png";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mediaType};base64,${part.source.data}` },
      });
    }
  }
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
}

function messagesToOpenAi(payload) {
  const messages = [];
  const system = flattenAnthropicText(payload.system).trim();
  if (system) messages.push({ role: "system", content: system });

  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (message.role === "assistant") {
      const text = [];
      const toolCalls = [];
      for (const part of Array.isArray(message.content) ? message.content : [message.content]) {
        if (typeof part === "string") text.push(part);
        else if (part?.type === "text") text.push(part.text || "");
        else if (part?.type === "tool_use") {
          toolCalls.push({
            id: part.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
            type: "function",
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input || {}),
            },
          });
        }
      }
      messages.push({
        role: "assistant",
        content: text.join(""),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const parts = Array.isArray(message.content) ? message.content : [message.content];
    const toolResults = parts.filter((part) => part?.type === "tool_result");
    const normalParts = parts.filter((part) => part?.type !== "tool_result");
    if (normalParts.length) {
      messages.push({ role: "user", content: anthropicContentToOpenAi(normalParts) });
    }
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: flattenAnthropicText(result.content),
      });
    }
  }
  return messages;
}

function toOpenAiChatPayload(payload, upstream) {
  const tools = anthropicToolsToOpenAi(payload.tools);
  return {
    ...upstream.body,
    model: upstream.apiModel,
    messages: messagesToOpenAi(payload),
    ...(typeof payload.max_tokens === "number" ? { max_tokens: payload.max_tokens } : {}),
    ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}),
    ...(typeof payload.top_p === "number" ? { top_p: payload.top_p } : {}),
    ...(Array.isArray(payload.stop_sequences) ? { stop: payload.stop_sequences } : {}),
    ...(tools ? { tools } : {}),
    stream: Boolean(payload.stream),
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function usageToAnthropic(usage) {
  const normalized = normalizeUsage(usage) || {};
  return {
    input_tokens: normalized.input_tokens || 0,
    output_tokens: normalized.output_tokens || 0,
  };
}

function openAiUsageToGeneric(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
  };
}

function openAiMessageToAnthropic(payload, upstream) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
      name: call.function?.name || "tool",
      input,
    });
  }
  return {
    id: payload.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: routeModel,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: content.some((part) => part.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: usageToAnthropic(openAiUsageToGeneric(payload.usage)),
    _meta: { provider: upstream.providerId, upstream_model: upstream.modelId },
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

class AnthropicStreamWriter {
  constructor(res) {
    this.res = res;
    this.messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    this.nextIndex = 0;
    this.textIndex = undefined;
    this.textOpen = false;
    this.started = false;
    this.textChars = 0;
    this.toolCalls = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    writeSse(this.res, "message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: routeModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  ensureTextBlock() {
    this.start();
    if (this.textOpen) return;
    this.textIndex = this.nextIndex++;
    this.textOpen = true;
    writeSse(this.res, "content_block_start", {
      type: "content_block_start",
      index: this.textIndex,
      content_block: { type: "text", text: "" },
    });
  }

  text(delta) {
    if (!delta) return;
    this.ensureTextBlock();
    this.textChars += delta.length;
    writeSse(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: this.textIndex,
      delta: { type: "text_delta", text: delta },
    });
  }

  closeTextBlock() {
    if (!this.textOpen) return;
    writeSse(this.res, "content_block_stop", {
      type: "content_block_stop",
      index: this.textIndex,
    });
    this.textOpen = false;
  }

  toolCall(call) {
    this.start();
    this.closeTextBlock();
    const index = this.nextIndex++;
    const args = call.function?.arguments || "{}";
    this.toolCalls += 1;
    writeSse(this.res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
        name: call.function?.name || "tool",
        input: {},
      },
    });
    if (args && args !== "{}") {
      writeSse(this.res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: args },
      });
    }
    writeSse(this.res, "content_block_stop", { type: "content_block_stop", index });
  }

  error(message) {
    this.start();
    this.closeTextBlock();
    writeSse(this.res, "error", {
      type: "error",
      error: { type: "api_error", message },
    });
  }

  stop(usage) {
    this.start();
    if (!this.textOpen && this.textChars === 0 && this.toolCalls === 0) this.ensureTextBlock();
    this.closeTextBlock();
    writeSse(this.res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: this.toolCalls > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: usageToAnthropic(usage),
    });
    writeSse(this.res, "message_stop", { type: "message_stop" });
  }
}

function parseSseFrame(frame) {
  const data = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return data.join("\n");
}

async function* parseSseStream(webStream) {
  if (!webStream) return;
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.trim()) yield parseSseFrame(frame);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseSseFrame(buffer);
  } finally {
    reader.releaseLock();
  }
}

async function streamOpenAiAsAnthropic(upstreamResponse, res, upstream) {
  res.writeHead(upstreamResponse.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-claude-desktop-shim-provider": "opencode-oauth",
    "x-claude-desktop-shim-model": upstream.modelId,
  });

  const writer = new AnthropicStreamWriter(res);
  const toolCalls = new Map();
  let usage;

  try {
    for await (const data of parseSseStream(upstreamResponse.body)) {
      if (!data || data === "[DONE]") continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (payload.error) {
        writer.error(payload.error.message || JSON.stringify(payload.error));
        res.end();
        return;
      }
      usage = openAiUsageToGeneric(payload.usage) || usage;
      const delta = payload.choices?.[0]?.delta || {};
      if (typeof delta.content === "string") writer.text(delta.content);
      for (const call of delta.tool_calls || []) {
        const key = call.index ?? call.id ?? toolCalls.size;
        const current = toolCalls.get(key) || {
          id: call.id,
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.function.name += call.function.name;
        if (call.function?.arguments) current.function.arguments += call.function.arguments;
        toolCalls.set(key, current);
      }
    }
    for (const call of toolCalls.values()) writer.toolCall(call);
    usageTracker.record(usage, { model: upstream.modelId });
    writer.stop(usage);
    res.end();
  } catch (error) {
    writer.error(`OpenCode stream failed: ${error?.message || String(error)}`);
    res.end();
  }
}

function formatUpstreamError(status, text) {
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  return String(payload?.error?.message || payload?.message || text || `HTTP ${status}`).slice(
    0,
    1500,
  );
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

  let credential;
  let upstream;
  try {
    credential = await resolveCredential();
    upstream = selectedUpstream(await fetchRemoteConfig(credential));
  } catch (error) {
    json(res, 500, {
      type: "error",
      error: {
        type: "configuration_error",
        message: error?.message || String(error),
      },
    });
    return;
  }

  const body = toOpenAiChatPayload(payload, upstream);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const headers = {
    ...upstream.headers,
    authorization: upstream.headers.authorization || upstream.headers.Authorization || `Bearer ${credential.accessToken}`,
    "content-type": "application/json",
    accept: body.stream ? "text/event-stream" : "application/json",
    "user-agent": "claude-desktop-shim",
  };
  copyHeader(headers, "x-org-id", credential.orgId);

  try {
    const response = await fetch(`${upstream.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (body.stream && response.headers.get("content-type")?.includes("text/event-stream")) {
      await streamOpenAiAsAnthropic(response, res, upstream);
      return;
    }

    const text = await response.text();
    if (!response.ok) {
      json(res, response.status, {
        type: "error",
        error: { type: "upstream_error", message: formatUpstreamError(response.status, text) },
      });
      return;
    }
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    const usage = openAiUsageToGeneric(parsed.usage) || usageFromPayload(parsed);
    usageTracker.record(usage, { model: upstream.modelId });
    json(res, 200, openAiMessageToAnthropic(parsed, upstream));
  } catch (error) {
    if (!res.headersSent) {
      const aborted = error?.name === "AbortError";
      json(res, aborted ? 504 : 502, {
        type: "error",
        error: {
          type: aborted ? "timeout_error" : "upstream_error",
          message: aborted
            ? `OpenCode request timed out after ${requestTimeoutMs}ms.`
            : `OpenCode request failed: ${error?.message || String(error)}`,
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
        display_name: `${routeModel} via OpenCode OAuth (${upstreamModel || "auto"})`,
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
    let hasAuth = false;
    let authSource = "";
    let selected;
    try {
      const credential = await resolveCredential();
      hasAuth = true;
      authSource = credential.source;
      selected = selectedUpstream(await fetchRemoteConfig(credential));
    } catch {
      hasAuth = false;
    }
    json(res, 200, {
      ok: true,
      provider: "opencode-oauth",
      routeModel,
      openCodeOrigin,
      providerId: selected?.providerId || providerId,
      upstreamModel: selected?.modelId || upstreamModel,
      upstreamBaseUrl: selected?.baseUrl || process.env.OPENCODE_BASE_URL || "",
      hasAuth,
      authSource,
      usage: usageTracker.snapshot(),
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
  console.error(`OpenCode OAuth gateway listening on http://${listenHost}:${listenPort}`);
  console.error(`Route model: ${routeModel}`);
  console.error(`OpenCode provider/model: ${providerId}/${upstreamModel || "auto"}`);
  console.error(`OpenCode auth: ${process.env.OPENCODE_ACCESS_TOKEN ? "OPENCODE_ACCESS_TOKEN" : authFile}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await delay(25);
    process.exit(0);
  });
}
