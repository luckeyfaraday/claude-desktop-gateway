function tokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;

  const inputTokens = tokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens);
  const upstreamTotal = tokenCount(usage.total_tokens);
  const totalTokens = Math.max(upstreamTotal, inputTokens + outputTokens);

  if (!inputTokens && !outputTokens && !totalTokens) return undefined;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

export function mergeUsage(current, usage) {
  const next = normalizeUsage(usage);
  if (!next) return current;
  if (!current) return next;

  const inputTokens = Math.max(current.input_tokens, next.input_tokens);
  const outputTokens = Math.max(current.output_tokens, next.output_tokens);
  const totalTokens = Math.max(
    current.total_tokens,
    next.total_tokens,
    inputTokens + outputTokens,
  );

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

export function usageFromPayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  return payload.usage || payload.message?.usage || payload.response?.usage;
}

export function usageFromSseFrame(frame) {
  const data = [];
  for (const rawLine of String(frame).split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }

  const body = data.join("\n").trim();
  if (!body || body === "[DONE]") return undefined;

  try {
    return usageFromPayload(JSON.parse(body));
  } catch {
    return undefined;
  }
}

export function createUsageTracker({ label = "", model = "" } = {}) {
  const startedAt = new Date().toISOString();
  const total = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let requests = 0;
  let last = null;

  function snapshot() {
    return {
      started_at: startedAt,
      requests,
      total: { ...total },
      last: last ? { ...last } : null,
    };
  }

  function record(usage, meta = {}) {
    const normalized = normalizeUsage(usage);
    if (!normalized) return undefined;

    requests += 1;
    total.input_tokens += normalized.input_tokens;
    total.output_tokens += normalized.output_tokens;
    total.total_tokens += normalized.total_tokens;

    last = {
      at: new Date().toISOString(),
      request: requests,
      model: meta.model || model,
      ...normalized,
    };

    const prefix = label ? `${label} ` : "";
    console.error(
      `${prefix}usage: input_tokens=${normalized.input_tokens} ` +
        `output_tokens=${normalized.output_tokens} total_tokens=${normalized.total_tokens} ` +
        `session_total_tokens=${total.total_tokens}`,
    );

    return last;
  }

  return { record, snapshot };
}
