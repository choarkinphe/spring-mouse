// Keep interpretation separate from the original evidence. In particular, a
// normalized HTTP 429 alone does not prove that an account has run out of credits.
export function getConnectionErrorEvidence(connection) {
  const upstreamAt = Date.parse(connection?.lastUpstreamAt || "") || 0;
  const gatewayAt = Date.parse(connection?.gatewayErrorAt || "") || 0;
  const upstream = connection?.lastUpstreamError || connection?.lastUpstreamRaw ? {
    kind: "upstream",
    text: connection.lastUpstreamError || "上游返回错误，详见原始报文",
    iso: connection.lastUpstreamAt || null,
    at: upstreamAt,
    status: connection.lastUpstreamStatus ?? null,
    source: connection.lastUpstreamSource || null,
    layer: connection.lastUpstreamLayer || "provider",
    raw: connection.lastUpstreamRaw ?? null,
  } : null;
  const gateway = connection?.gatewayError ? {
    kind: "gateway", text: connection.gatewayError,
    iso: connection.gatewayErrorAt || null, at: gatewayAt,
    status: connection.gatewayErrorCode ?? null, source: null,
    layer: "gateway", raw: null,
  } : null;
  if (!upstream) return gateway;
  if (!gateway) return upstream;
  return gatewayAt > upstreamAt ? gateway : upstream;
}

export function getErrorEvidenceLayerLabel(evidence) {
  if (!evidence) return "";
  if (evidence.layer === "gateway") return "中间网关";
  if (evidence.layer === "network") return "网络层";
  if (evidence.source === "sse") return "模型上游 SSE";
  return `模型 HTTP ${evidence.status ?? "未知"}`;
}

function rawText(raw) {
  if (raw == null) return "";
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

export function analyzeConnectionError(evidence) {
  if (!evidence) return null;
  const text = `${evidence.text}\n${rawText(evidence.raw)}`;
  const status = Number(evidence.status);
  if (evidence.kind === "gateway" || evidence.layer === "network" || evidence.layer === "gateway") {
    return { reason: "网关或网络链路失败", basis: "记录来自网关 / 网络层，不能据此判断模型账号失效或积分不足。", suggestion: "检查网关、Mouse 节点和上游之间的连接、代理与超时记录，再重试。" };
  }
  if (/quota|insufficient[_\s-]*(?:credits?|balance|funds)|credit[_\s-]*(?:limit|exhaust|insufficient)|额度|余额不足|积分不足|配额.*(?:超|不足|耗尽)/i.test(text)) {
    return { reason: "上游额度或余额限制", basis: "错误文本或原始报文包含额度 / 余额限制信息；具体限制范围以上游报文为准。", suggestion: "刷新上游配额并核实订阅、余额及模型权限；不要将其直接当作登录失效。" };
  }
  if (status === 401 || /token.*(?:expired|invalid)|unauthenticated|凭据.*失效/i.test(text)) {
    return { reason: "上游身份验证失败", basis: "上游状态码或报文指向身份凭据问题。", suggestion: "检查凭据是否过期，刷新令牌或重新授权后重试。" };
  }
  if (status === 403) {
    return { reason: "上游拒绝访问", basis: "上游返回 403；仅凭状态码无法确定是权限、风控还是账号限制。", suggestion: "根据原始报文核实模型权限、地区及账号限制。" };
  }
  if (/resource.*(?:exhaust|unavailable)|overload|capacity|排队|资源受限|资源不足|繁忙/i.test(text)) {
    return { reason: "上游资源繁忙或排队", basis: "错误信息指向资源 / 容量限制，不足以证明账号余额不足。", suggestion: "稍后重试，或切换模型 / 账号；避免反复重新登录。" };
  }
  if (status === 429 || /rate.?limit|too many requests|限流/i.test(text)) {
    return { reason: "上游限流或用量限制", basis: "上游返回限流信号；429 本身无法区分请求频率、并发和额度限制。", suggestion: "结合原始报文核实限制类型，降低并发并等待重试窗口。" };
  }
  if (status >= 500) {
    return { reason: "上游服务异常", basis: "上游返回 5xx 错误，不能直接归因于本地配置或账号失效。", suggestion: "稍后重试或切换渠道；持续失败时携带完整报文排查。" };
  }
  return { reason: "暂无法确定具体失败原因", basis: "现有记录不足以可靠归因，请以原始上游报文为依据。", suggestion: "检查原始报文中的错误码、请求 ID 和参数；必要时用完整错误详情进一步排查。" };
}

export function formatConnectionErrorDetails(connection, evidence, { accountName, providerName, time } = {}) {
  if (!evidence) return "";
  const analysis = analyzeConnectionError(evidence);
  return [
    `账号：${accountName || connection.name || connection.displayName || connection.email || "未命名配置"}`,
    `渠道：${providerName || connection.provider}`,
    connection.mouseId ? `Mouse：${connection.mouseId}` : null,
    evidence.iso ? `时间：${time || evidence.iso}` : null,
    `错误层级：${getErrorEvidenceLayerLabel(evidence)}`,
    `记录状态码：${evidence.status ?? "未知"}${evidence.source === "sse" ? "（SSE 传输状态；业务错误码见原始报文，HTTP 200 不代表请求成功）" : ""}`,
    `来源：${evidence.source || evidence.kind}`,
    "", "失败原因分析（基于已记录证据，非上游原文）", analysis.reason,
    `判断依据：${analysis.basis}`, `处理建议：${analysis.suggestion}`,
    "", "错误摘要", evidence.text,
    "", "原始上游报文（已记录内容）",
    rawText(evidence.raw) || "未记录原始上游报文；无法从摘要还原。",
  ].filter((line) => line != null).join("\n");
}
