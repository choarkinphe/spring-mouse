import { QODER_LIMITS } from "open-sse/config/errorConfig.js";

// Diagnostic data is untrusted. Decode a bounded number of JSON wrappers;
// never infer a permanent account or credit state from a queue response.
export function decodeErrorLayers(evidence) {
  const pending = [evidence?.text, evidence?.raw];
  const layers = [];
  for (let i = 0; i < pending.length && i < 12; i++) {
    let value = pending[i];
    if (typeof value === "string") {
      if (value.length > 65536) continue;
      try { value = JSON.parse(value); } catch { continue; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    layers.push(value);
    for (const key of ["message", "error", "body"]) {
      if (pending.length < 12 && value[key] != null) pending.push(value[key]);
    }
  }
  return layers;
}

// Largest explicit retry hint in seconds, or null when upstream gave none.
export function retryAfterSeconds(layers) {
  const seconds = layers.map(item => Number(item.retryAfterSeconds ?? item.retryAfter ?? item.retry_after))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 86400);
  return seconds.length ? Math.ceil(Math.max(...seconds)) : null;
}

// Qoder business codes: queue / resource limit, daily request count, quota.
export function classifyQoderError(provider, evidence, layers = decodeErrorLayers(evidence)) {
  if (!QODER_LIMITS.providers.has(provider) || evidence?.kind !== "upstream") return null;
  const has = (code) => layers.some(item => Number(item.code) === code);
  if (has(QODER_LIMITS.queueCode)) return { kind: "queue", retryAfterSeconds: retryAfterSeconds(layers) };
  if (has(QODER_LIMITS.dailyCountCode)) return { kind: "dailyCount" };
  if (has(QODER_LIMITS.quotaCode)) return { kind: "quota" };
  return null;
}

export function summarizeQoderError(provider, evidence) {
  const result = classifyQoderError(provider, evidence);
  if (result?.kind === "queue") {
    // The upstream hint is reported, not endorsed: a queued account usually stays queued far longer.
    const hint = result.retryAfterSeconds ? `（上游提示 ${result.retryAfterSeconds} 秒后重试，实际可能持续更久）` : "";
    return `上游模型资源受限／排队${hint}；不代表积分不足或账号失效`;
  }
  if (result?.kind === "dailyCount") {
    return `上游每日请求次数已达上限（${QODER_LIMITS.dailyCountCode}），当日重试无效；不是登录失效`;
  }
  if (result?.kind === "quota") {
    return `上游额度限制（${QODER_LIMITS.quotaCode}），请刷新积分核实余额或订阅；不是登录失效`;
  }
  return null;
}
