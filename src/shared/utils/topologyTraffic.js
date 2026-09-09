export const COMPLETED_FLOW_TTL_MS = 6000;
export const INPUT_FLOW_COLOR = "#3b82f6";
export const OUTPUT_FLOW_COLOR = "#10b981";

export function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function getTokenMotion(tokens) {
  const amount = tokenCount(tokens);
  if (!amount) return { count: 0, duration: 3.2 };
  // Logarithmic scaling keeps 100-token replies visible beside 100k prompts.
  const intensity = Math.min(1, Math.log10(1 + amount) / 6);
  return { count: Math.min(10, Math.ceil(intensity * 10)), duration: 3.2 - intensity * 2.3 };
}

export function getTopologyRequests(activeRequests, recentRequests, now) {
  const active = activeRequests.filter((request) => request?.provider);
  const seen = new Set();
  const completed = recentRequests.flatMap((request) => {
    const age = now - Date.parse(request.timestamp);
    if (!request.provider || !Number.isFinite(age) || age < 0 || age >= COMPLETED_FLOW_TTL_MS) return [];
    const id = request.requestId || [request.timestamp, request.apiKeyId, request.provider, request.model].join("|");
    if (seen.has(id)) return [];
    seen.add(id);
    return [{
      ...request,
      count: 0,
      inputTokens: tokenCount(request.promptTokens),
      outputTokens: tokenCount(request.completionTokens),
      apiKey: {
        id: request.apiKeyId === "local-no-key" ? "local" : request.apiKeyId,
        name: request.userName,
      },
    }];
  });
  return [...active, ...completed];
}

export function makeTokenPath(x, y, width, height, inbound, offset) {
  const centerX = width / 2 + offset;
  const centerY = height / 2;
  const endX = x + offset;
  const sign = y < centerY ? -1 : 1;
  const bendY = centerY + sign * height * 0.1;
  const endBendY = y - sign * height * 0.08;
  return inbound
    ? `M ${endX} ${y} C ${endX} ${endBendY}, ${centerX} ${bendY}, ${centerX} ${centerY}`
    : `M ${centerX} ${centerY} C ${centerX} ${bendY}, ${endX} ${endBendY}, ${endX} ${y}`;
}
