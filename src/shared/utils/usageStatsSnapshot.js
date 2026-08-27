const CUMULATIVE_FIELDS = [
  "totalRequests",
  "completedRequests",
  "failedRequests",
  "cancelledRequests",
  "meteredRequests",
  "totalPromptTokens",
  "totalCompletionTokens",
  "totalCachedTokens",
  "totalCost",
  "totalRequestBytes",
  "totalResponseBytes",
  "totalTrafficBytes",
];

const LIVE_FIELDS = [
  "activeRequests",
  "recentRequests",
  "errorProvider",
  "pending",
  "last10Minutes",
  "streamUpdatedAt",
];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isUsageStatsRegression(previous, incoming) {
  if (!previous || !incoming) return false;
  return CUMULATIVE_FIELDS.some((field) => {
    const previousValue = finiteNumber(previous[field]);
    const incomingValue = finiteNumber(incoming[field]);
    return previousValue !== null && incomingValue !== null && incomingValue < previousValue;
  });
}

export function applyUsageStatsUpdate(previous, incoming, { streamPatch = false } = {}) {
  if (!incoming) return previous;
  if (!previous) return streamPatch ? previous : incoming;
  if (streamPatch) return { ...previous, ...incoming };
  if (!isUsageStatsRegression(previous, incoming)) return incoming;

  const livePatch = {};
  for (const field of LIVE_FIELDS) {
    if (Object.hasOwn(incoming, field)) livePatch[field] = incoming[field];
  }
  return { ...previous, ...livePatch };
}
