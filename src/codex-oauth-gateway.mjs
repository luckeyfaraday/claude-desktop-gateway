#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL =
  process.env.CODEX_OAUTH_TOKEN_URL || "https://auth.openai.com/oauth/token";

const listenHost = process.env.CODEX_GATEWAY_HOST || "127.0.0.1";
const listenPort = Number(process.env.CODEX_GATEWAY_PORT || "8787");
const routeModel = process.env.CLAUDE_ROUTE_MODEL || "claude-sonnet-4-5";
const codexModel = process.env.CODEX_MODEL || process.env.OPENAI_MODEL || "gpt-5.5";
const codexBaseUrl = (
  process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex"
).replace(/\/+$/, "");
const requestTimeoutMs = Number(process.env.CODEX_TIMEOUT_MS || "300000");
const refreshSkewSeconds = Number(process.env.CODEX_REFRESH_SKEW_SECONDS || "120");
const appTitle = process.env.CODEX_APP_TITLE || "claude-desktop-shim";

function homeDir() {
  const home = os.homedir() || process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("Could not determine the current user's home directory.");
  return home;
}

function codexAuthFile() {
  if (process.env.CODEX_AUTH_FILE) return path.resolve(process.env.CODEX_AUTH_FILE);
  const codexHome = process.env.CODEX_HOME || path.join(homeDir(), ".codex");
  return path.join(path.resolve(codexHome), "auth.json");
}

function hermesAuthFile() {
  if (process.env.HERMES_AUTH_FILE) return path.resolve(process.env.HERMES_AUTH_FILE);
  const hermesHome = process.env.HERMES_HOME || path.join(homeDir(), ".hermes");
  return path.join(path.resolve(hermesHome), "auth.json");
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

function decodeJwtPayload(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function tokenExpiresAt(token) {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp : undefined;
}

function tokenIsExpiring(token, skewSeconds = refreshSkewSeconds) {
  const exp = tokenExpiresAt(token);
  if (!exp) return false;
  return exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

function chatGptAccountIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  return typeof auth?.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
}

function asTokenPair(value) {
  if (!value || typeof value !== "object") return undefined;
  const accessToken =
    typeof value.access_token === "string" ? value.access_token.trim() : "";
  const refreshToken =
    typeof value.refresh_token === "string" ? value.refresh_token.trim() : "";
  if (!accessToken) return undefined;
  return { accessToken, refreshToken };
}

function codexCliCandidate() {
  const file = codexAuthFile();
  const payload = readJsonFile(file);
  const tokens = asTokenPair(payload?.tokens);
  if (!tokens) return undefined;
  return {
    source: file,
    tokens,
    save(refreshed) {
      const next = { ...payload };
      next.tokens = {
        ...(payload.tokens || {}),
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken || tokens.refreshToken,
        last_refresh: new Date().toISOString(),
      };
      if (refreshed.idToken) next.tokens.id_token = refreshed.idToken;
      writeJsonFile(file, next);
    },
  };
}

function hermesProviderCandidate(payload, file) {
  const provider = payload?.providers?.["openai-codex"];
  const tokens = asTokenPair(provider?.tokens);
  if (!tokens) return undefined;
  return {
    source: `${file} providers.openai-codex`,
    tokens,
    save(refreshed) {
      const next = { ...payload };
      next.providers = { ...(payload.providers || {}) };
      next.providers["openai-codex"] = { ...(provider || {}) };
      next.providers["openai-codex"].tokens = {
        ...(provider.tokens || {}),
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken || tokens.refreshToken,
      };
      if (refreshed.idToken) {
        next.providers["openai-codex"].tokens.id_token = refreshed.idToken;
      }
      next.providers["openai-codex"].last_refresh = new Date().toISOString();
      next.providers["openai-codex"].auth_mode =
        next.providers["openai-codex"].auth_mode || "chatgpt";
      writeJsonFile(file, next);
    },
  };
}

function hermesPoolCandidates(payload, file) {
  const entries = payload?.credential_pool?.["openai-codex"];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry, index) => {
      const tokens = asTokenPair(entry);
      if (!tokens) return undefined;
      return {
        source: `${file} credential_pool.openai-codex[${index}]`,
        tokens,
        save(refreshed) {
          const next = { ...payload };
          next.credential_pool = { ...(payload.credential_pool || {}) };
          next.credential_pool["openai-codex"] = [...entries];
          next.credential_pool["openai-codex"][index] = {
            ...(entry || {}),
            access_token: refreshed.accessToken,
            refresh_token: refreshed.refreshToken || tokens.refreshToken,
            last_refresh: new Date().toISOString(),
            last_status: null,
            last_error_code: null,
            last_error_message: null,
          };
          writeJsonFile(file, next);
        },
      };
    })
    .filter(Boolean);
}

function hermesCandidates() {
  const file = hermesAuthFile();
  const payload = readJsonFile(file);
  if (!payload) return [];
  return [
    hermesProviderCandidate(payload, file),
    ...hermesPoolCandidates(payload, file),
  ].filter(Boolean);
}

async function refreshCodexTokens(tokens) {
  if (!tokens.refreshToken) {
    throw new Error("Codex credential has no refresh_token.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    });
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.error_description ||
        payload?.error ||
        text ||
        `HTTP ${response.status}`;
      throw new Error(`Codex token refresh failed: ${message}`);
    }
    if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      throw new Error("Codex token refresh response was missing access_token.");
    }
    return {
      accessToken: payload.access_token.trim(),
      refreshToken:
        typeof payload.refresh_token === "string" && payload.refresh_token.trim()
          ? payload.refresh_token.trim()
          : tokens.refreshToken,
      idToken:
        typeof payload.id_token === "string" && payload.id_token.trim()
          ? payload.id_token.trim()
          : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCodexCredential() {
  const envAccessToken =
    process.env.CODEX_ACCESS_TOKEN || process.env.OPENAI_CODEX_ACCESS_TOKEN;
  if (envAccessToken?.trim()) {
    return { accessToken: envAccessToken.trim(), source: "CODEX_ACCESS_TOKEN" };
  }

  const candidates = [
    codexCliCandidate(),
    ...hermesCandidates(),
  ].filter(Boolean);

  const errors = [];
  for (const candidate of candidates) {
    const { accessToken, refreshToken } = candidate.tokens;
    if (!tokenIsExpiring(accessToken)) {
      return { accessToken, source: candidate.source };
    }
    if (!refreshToken) continue;
    try {
      const refreshed = await refreshCodexTokens(candidate.tokens);
      candidate.save?.(refreshed);
      return { accessToken: refreshed.accessToken, source: `${candidate.source} refreshed` };
    } catch (error) {
      errors.push(`${candidate.source}: ${error?.message || String(error)}`);
    }
  }

  const suffix = errors.length ? ` Last refresh error: ${errors[errors.length - 1]}` : "";
  throw new Error(
    `No usable Codex OAuth credential found. Run \`codex login\` or \`hermes auth add openai-codex\`.${suffix}`,
  );
}

function anthropicError(type, message) {
  return { type: "error", error: { type, message } };
}

function flattenAnthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const chunks = [];
  for (const part of content) {
    if (typeof part === "string") chunks.push(part);
    else if (part?.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function systemToInstructions(system) {
  const text = flattenAnthropicText(system).trim();
  return text || "You are a helpful assistant.";
}

function imagePartToResponses(part) {
  const source = part?.source;
  if (!source || typeof source !== "object") return undefined;
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType = source.media_type || "image/png";
    return {
      type: "input_image",
      image_url: `data:${mediaType};base64,${source.data}`,
    };
  }
  return undefined;
}

function userContentParts(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: content == null ? "" : String(content) }];
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ type: "input_text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      const image = imagePartToResponses(part);
      if (image) parts.push(image);
    }
  }
  return parts;
}

function assistantContentParts(content) {
  if (typeof content === "string") return [{ type: "output_text", text: content }];
  if (!Array.isArray(content)) {
    return [{ type: "output_text", text: content == null ? "" : String(content) }];
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ type: "output_text", text: part });
      continue;
    }
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push({ type: "output_text", text: part.text });
    }
  }
  return parts;
}

function toolResultOutput(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = userContentParts(content);
  const textOnly = parts.every((part) => part.type === "input_text");
  if (textOnly) return parts.map((part) => part.text || "").join("");
  return parts;
}

function appendUserMessage(items, content) {
  if (!Array.isArray(content)) {
    items.push({ role: "user", content: flattenAnthropicText(content) });
    return;
  }

  let pendingParts = [];
  const flushPending = () => {
    if (pendingParts.length) {
      items.push({ role: "user", content: pendingParts });
      pendingParts = [];
    }
  };

  for (const part of content) {
    if (part?.type === "tool_result") {
      flushPending();
      if (typeof part.tool_use_id === "string" && part.tool_use_id.trim()) {
        items.push({
          type: "function_call_output",
          call_id: part.tool_use_id.trim(),
          output: toolResultOutput(part.content),
        });
      }
      continue;
    }
    pendingParts.push(...userContentParts([part]));
  }
  flushPending();
}

function appendAssistantMessage(items, content) {
  if (!Array.isArray(content)) {
    items.push({ role: "assistant", content: flattenAnthropicText(content) });
    return;
  }

  let pendingParts = [];
  const flushPending = () => {
    if (pendingParts.length) {
      items.push({ role: "assistant", content: pendingParts });
      pendingParts = [];
    }
  };

  for (const part of content) {
    if (part?.type === "tool_use") {
      flushPending();
      const name = typeof part.name === "string" ? part.name.trim() : "";
      const callId = typeof part.id === "string" ? part.id.trim() : "";
      if (name && callId) {
        items.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: JSON.stringify(part.input || {}),
        });
      }
      continue;
    }
    pendingParts.push(...assistantContentParts([part]));
  }
  flushPending();
}

function messagesToResponsesInput(messages) {
  const items = [];
  if (!Array.isArray(messages)) return items;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") {
      appendUserMessage(items, message.content);
    } else if (message.role === "assistant") {
      appendAssistantMessage(items, message.content);
    }
  }
  return items;
}

function toolsToResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) continue;
    converted.push({
      type: "function",
      name,
      description:
        typeof tool.description === "string" ? tool.description : "",
      strict: false,
      parameters:
        tool.input_schema && typeof tool.input_schema === "object"
          ? tool.input_schema
          : { type: "object", properties: {} },
    });
  }
  return converted.length ? converted : undefined;
}

function toolChoiceToResponses(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return { type: "function", name: toolChoice.name };
  }
  return undefined;
}

function promptCacheKey(instructions, tools) {
  const hash = crypto.createHash("sha256");
  hash.update(instructions || "");
  hash.update("\0");
  if (tools) hash.update(JSON.stringify(tools));
  return `pck_${hash.digest("hex").slice(0, 24)}`;
}

function buildResponsesPayload(anthropicPayload, stream) {
  const instructions = systemToInstructions(anthropicPayload.system);
  const input = messagesToResponsesInput(anthropicPayload.messages);
  if (!input.length) input.push({ role: "user", content: "" });

  const tools = toolsToResponsesTools(anthropicPayload.tools);
  const body = {
    model: codexModel,
    instructions,
    input,
    store: false,
    prompt_cache_key: promptCacheKey(instructions, tools),
  };

  if (stream) body.stream = true;
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoiceToResponses(anthropicPayload.tool_choice) || "auto";
    body.parallel_tool_calls = true;
  }

  const effort = (process.env.CODEX_REASONING_EFFORT || "medium").trim();
  if (effort && effort !== "none") {
    body.reasoning = {
      effort: effort === "minimal" ? "low" : effort,
      summary: "auto",
    };
    body.include = ["reasoning.encrypted_content"];
  }

  return body;
}

function usageToAnthropic(usage) {
  if (!usage || typeof usage !== "object") {
    return { input_tokens: 0, output_tokens: 0 };
  }
  return {
    input_tokens: Number(usage.input_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
  };
}

function parseMaybeJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function outputItemText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.output_text === "string") return item.output_text;
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
  const chunks = [];
  for (const part of item.content) {
    if (!part || typeof part !== "object") continue;
    if (
      (part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string"
    ) {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function extractResponseText(responsePayload) {
  if (typeof responsePayload?.output_text === "string") {
    return responsePayload.output_text;
  }
  if (!Array.isArray(responsePayload?.output)) return "";
  return responsePayload.output.map(outputItemText).join("");
}

function extractToolCalls(responsePayload) {
  if (!Array.isArray(responsePayload?.output)) return [];
  const calls = [];
  for (const item of responsePayload.output) {
    if (!item || typeof item !== "object" || item.type !== "function_call") {
      continue;
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    calls.push({
      id:
        typeof item.call_id === "string" && item.call_id.trim()
          ? item.call_id.trim()
          : item.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
      name,
      input: parseMaybeJson(item.arguments, {}),
    });
  }
  return calls;
}

function responsesToAnthropicMessage(responsePayload) {
  const text = extractResponseText(responsePayload);
  const toolCalls = extractToolCalls(responsePayload);
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  return {
    id: responsePayload?.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: routeModel,
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: usageToAnthropic(responsePayload?.usage),
  };
}

function codexRequestHeaders(accessToken, requestId, stream) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: stream ? "text/event-stream" : "application/json",
    "content-type": "application/json",
    "user-agent": `codex_cli_rs/0.0.0 (${appTitle})`,
    originator: "codex_cli_rs",
    session_id: process.env.CODEX_SESSION_ID || "claude-desktop-shim",
    "x-client-request-id": requestId,
  };
  const accountId = chatGptAccountIdFromToken(accessToken);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

function formatUpstreamError(status, text) {
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  const message =
    payload?.error?.message ||
    payload?.error_description ||
    payload?.message ||
    text ||
    `HTTP ${status}`;
  return String(message).slice(0, 1500);
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
    const args = typeof call.arguments === "string" ? call.arguments : "{}";
    const callId =
      typeof call.call_id === "string" && call.call_id.trim()
        ? call.call_id.trim()
        : call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`;
    this.toolCalls += 1;
    writeSse(this.res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: callId,
        name: call.name,
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
    writeSse(this.res, "content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }

  error(message) {
    this.start();
    this.closeTextBlock();
    writeSse(this.res, "error", {
      type: "error",
      error: { type: "api_error", message },
    });
  }

  stop({ usage, status } = {}) {
    this.start();
    if (!this.textOpen && this.textChars === 0 && this.toolCalls === 0) {
      this.ensureTextBlock();
    }
    this.closeTextBlock();
    const stopReason =
      this.toolCalls > 0 ? "tool_use" : status === "incomplete" ? "max_tokens" : "end_turn";
    writeSse(this.res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: usageToAnthropic(usage),
    });
    writeSse(this.res, "message_stop", { type: "message_stop" });
  }
}

function parseSseFrame(frame) {
  let event = "";
  const data = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return { event, data: data.join("\n") };
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

async function streamResponsesAsAnthropic(upstream, res) {
  res.writeHead(upstream.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-claude-desktop-shim-provider": "codex-oauth",
    "x-claude-desktop-shim-model": codexModel,
  });

  const writer = new AnthropicStreamWriter(res);
  let usage;
  let status;

  try {
    for await (const frame of parseSseStream(upstream.body)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      let payload;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }
      const type = payload.type || frame.event;
      if (type === "error") {
        writer.error(formatUpstreamError(502, JSON.stringify(payload)));
        res.end();
        return;
      }
      if (type?.includes("output_text.delta")) {
        writer.text(typeof payload.delta === "string" ? payload.delta : "");
        continue;
      }
      if (type === "response.output_item.done") {
        const item = payload.item;
        if (item?.type === "function_call") {
          writer.toolCall(item);
        } else if (writer.textChars === 0) {
          writer.text(outputItemText(item));
        }
        continue;
      }
      if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
        usage = payload.response?.usage || usage;
        status = payload.response?.status || type.replace("response.", "");
        if (type === "response.failed") {
          writer.error(formatUpstreamError(502, JSON.stringify(payload.response || payload)));
          res.end();
          return;
        }
        break;
      }
    }
    writer.stop({ usage, status });
    res.end();
  } catch (error) {
    writer.error(`Codex stream failed: ${error?.message || String(error)}`);
    res.end();
  }
}

async function consumeResponsesStream(webStream) {
  const text = [];
  const output = [];
  let usage;
  let status = "completed";
  let id;

  for await (const frame of parseSseStream(webStream)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const type = payload.type || frame.event;
    if (type === "error") {
      throw new Error(formatUpstreamError(502, JSON.stringify(payload)));
    }
    if (type?.includes("output_text.delta")) {
      if (typeof payload.delta === "string") text.push(payload.delta);
      continue;
    }
    if (type === "response.output_item.done") {
      if (payload.item) output.push(payload.item);
      continue;
    }
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      usage = payload.response?.usage || usage;
      status = payload.response?.status || type.replace("response.", "");
      id = payload.response?.id || id;
      if (type === "response.failed") {
        throw new Error(formatUpstreamError(502, JSON.stringify(payload.response || payload)));
      }
      break;
    }
  }

  return {
    id,
    status,
    output,
    output_text: text.join(""),
    usage,
  };
}

async function handleMessages(req, res) {
  let credential;
  try {
    credential = await resolveCodexCredential();
  } catch (error) {
    json(res, 500, anthropicError("configuration_error", error.message));
    return;
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    json(res, 400, anthropicError("invalid_request_error", "Invalid JSON body."));
    return;
  }

  const clientWantsStream = payload.stream !== false;
  const upstreamStream = true;
  const requestId = crypto.randomUUID();
  const upstreamPayload = buildResponsesPayload(payload, upstreamStream);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const upstream = await fetch(`${codexBaseUrl}/responses`, {
      method: "POST",
      headers: codexRequestHeaders(credential.accessToken, requestId, upstreamStream),
      body: JSON.stringify(upstreamPayload),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      json(
        res,
        upstream.status,
        anthropicError("upstream_error", formatUpstreamError(upstream.status, text)),
      );
      return;
    }

    if (clientWantsStream) {
      await streamResponsesAsAnthropic(upstream, res);
      return;
    }

    const responsePayload = await consumeResponsesStream(upstream.body);
    const out = responsesToAnthropicMessage(responsePayload);
    res.setHeader("x-claude-desktop-shim-provider", "codex-oauth");
    res.setHeader("x-claude-desktop-shim-model", codexModel);
    json(res, 200, out);
  } catch (error) {
    if (!res.headersSent) {
      const aborted = error?.name === "AbortError";
      json(
        res,
        aborted ? 504 : 502,
        anthropicError(
          aborted ? "timeout_error" : "upstream_error",
          aborted
            ? `Codex request timed out after ${requestTimeoutMs}ms.`
            : `Codex request failed: ${error?.message || String(error)}`,
        ),
      );
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
        display_name: `${routeModel} route via Codex OAuth (${codexModel})`,
        created_at: 0,
      },
    ],
    has_more: false,
    first_id: routeModel,
    last_id: routeModel,
  });
}

async function handleCountTokens(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    json(res, 400, anthropicError("invalid_request_error", "Invalid JSON body."));
    return;
  }
  const text = JSON.stringify({
    system: payload.system || "",
    messages: payload.messages || [],
    tools: payload.tools || [],
  });
  json(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    let authSource = "";
    try {
      authSource = (await resolveCodexCredential()).source;
    } catch {
      authSource = "";
    }
    json(res, 200, {
      ok: true,
      provider: "codex-oauth",
      routeModel,
      codexModel,
      codexBaseUrl,
      hasAuth: Boolean(authSource),
      authSource: authSource ? authSource.replace(homeDir(), "~") : "",
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

  json(res, 404, anthropicError("not_found_error", "Route not found."));
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(listenPort, listenHost, () => {
  console.error(`Codex OAuth gateway listening on http://${listenHost}:${listenPort}`);
  console.error(`Claude Desktop route model label: ${routeModel}`);
  console.error(`Codex upstream model: ${codexModel}`);
  console.error(`Codex upstream base: ${codexBaseUrl}`);
  console.error(`Codex auth search: ${codexAuthFile()} then ${hermesAuthFile()}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await delay(25);
    process.exit(0);
  });
}
