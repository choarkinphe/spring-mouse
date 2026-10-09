const TEMPORARY = /unauthori[sz]ed|invalid.*(?:key|token)|subscription|credit|quota|payment|rate.limit|overload|not found|does not exist|permission|access denied/i;
const CAPABILITY_NAMES = {
  tools: /tool|function.call/i, vision: /image|vision|multimodal/i, pdf: /pdf|document|file.input/i,
  audioInput: /audio/i, videoInput: /video/i, reasoning: /reasoning|thinking/i,
  structuredOutput: /json.schema|response.format|structured.output/i,
  imageOutput: /image.generation|image.output/i, audioOutput: /audio.output|speech|tts/i,
};

export function redactEvidence(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets.filter((item) => typeof item === "string" && item.length > 3)) text = text.split(secret).join("[redacted]");
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/(?:sk-|sess-)[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/https?:\/\/\S+/g, "[url omitted]").slice(0, 600);
}

export function explicitContextLimit(message) {
  const text = String(message || "");
  const total = text.match(/maximum context (?:length|window)(?:\s+(?:is|of))?[^\d]{0,30}([\d,]+)\s*tokens/i)
    || text.match(/context (?:length|window) (?:limit|maximum)(?:\s+(?:is|of))?[^\d]{0,20}([\d,]+)\s*tokens/i);
  const input = text.match(/max(?:imum)? input (?:length|tokens)(?:\s+(?:is|of))?[^\d]{0,20}([\d,]+)(?:\s*tokens)?/i);
  const match = total || input;
  if (!match) return null;
  const explicitLimit = Number(match[1].replaceAll(",", ""));
  return Number.isInteger(explicitLimit) && explicitLimit > 0 ? { explicitLimit, limitKind: total ? "total" : "input" } : null;
}

export function classifyProbeFailure(key, status, message, { upstream = true } = {}) {
  const detail = String(message || "");
  if (!upstream || ![400, 422].includes(Number(status)) || TEMPORARY.test(detail)) return { status: "unknown", reason: detail || "请求未能完成" };
  if (key === "contextWindow") {
    const limit = explicitContextLimit(detail);
    if (limit || /context.length.exceeded|too many (?:input )?tokens|input.*exceeds.*(?:context|token)|context.*(?:exceed|too long)/i.test(detail)) {
      return { status: "supported", reason: "上游明确拒绝超长输入；不是模型不支持上下文", context: { rejected: true, ...limit } };
    }
  }
  if (CAPABILITY_NAMES[key]?.test(detail) && /not support|unsupported|does not support|cannot (?:process|accept)|not allowed|only.*text/i.test(detail)) return { status: "unsupported", reason: detail };
  return { status: "unknown", reason: detail || "上游拒绝请求，但无法确定是能力限制" };
}

export function responseText(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => block.text || "").join("\n");
  return (json?.content || []).map?.((block) => block.text || "").join("\n") || "";
}

export function validateProbeResponse(key, json, expected) {
  const text = responseText(json);
  const choice = json?.choices?.[0];
  if (json?.error) return { status: "unknown", reason: String(json.error.message || json.error) };
  if (key === "tools") {
    const call = choice?.message?.tool_calls?.find((item) => item.function?.name === "capability_echo");
    let args;
    try { args = JSON.parse(call?.function?.arguments); } catch {}
    if (args?.code === expected[0]) return { status: "supported", reason: "返回了正确函数及随机参数" };
  } else if (key === "reasoning") {
    const message = choice?.message || {};
    if ([message.reasoning, message.reasoning_content, message.thinking, message.thinking_content].some((value) => typeof value === "string" && value.trim())) return { status: "supported", reason: "返回可观测的推理内容（不等于推理质量评估）" };
  } else if (key === "structuredOutput") {
    try {
      const parsed = JSON.parse(text);
      if (Object.keys(parsed).length === 1 && parsed.code === expected[0]) return { status: "supported", reason: "schema 请求返回了正确结构与随机标识；不保证所有 schema 都支持" };
    } catch {}
  } else {
    const normalized = text.toLowerCase();
    let cursor = 0;
    const correct = expected.length > 0 && expected.every((item) => {
      const at = normalized.indexOf(item.toLowerCase(), cursor);
      if (at < 0) return false;
      cursor = at + item.length;
      return true;
    });
    if (correct) return { status: "supported", reason: key === "contextWindow" ? "头、中、尾标识检索通过（仅证明已测试下限）" : "标准答案验证通过" };
  }
  return { status: "unknown", reason: choice?.finish_reason === "length" ? "输出预算耗尽，未能确认能力" : "请求被接受，但答案未通过验证；不能据此判为不支持" };
}
