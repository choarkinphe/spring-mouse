// Diagnostic data is untrusted. Decode a bounded number of JSON wrappers;
// never infer a permanent account or credit state from a queue response.
export function summarizeQoderError(provider, evidence) {
  if (!["qoder", "qoder-cn"].includes(provider) || evidence?.kind !== "upstream") return null;
  const pending = [evidence.text, evidence.raw];
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
  if (layers.some(item => Number(item.code) === 10605)) {
    const seconds = layers.map(item => Number(item.retryAfterSeconds ?? item.retryAfter ?? item.retry_after))
      .filter(n => Number.isFinite(n) && n > 0 && n <= 86400);
    const delay = seconds.length ? `，建议 ${Math.ceil(Math.max(...seconds))} 秒后重试` : "，请稍后重试";
    return `上游模型资源受限／排队${delay}；不代表积分不足或账号失效`;
  }
  if (layers.some(item => Number(item.code) === 112)) {
    return "上游额度限制（112），请刷新积分核实余额或订阅；不是登录失效";
  }
  return null;
}
