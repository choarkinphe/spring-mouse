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

const NUMERIC_FIELDS = new Set([
  ...CUMULATIVE_FIELDS,
  "requests",
  "promptTokens",
  "completionTokens",
  "cachedTokens",
  "cost",
  "requestBytes",
  "responseBytes",
  "trafficBytes",
  "requestDurationMs",
  "durationRequestCount",
  "activeSessionDurationMs",
  "activeDays",
  "sessionCount",
]);

const COUNTER_MAP_FIELDS = ["byProvider", "byModel", "bySourceIp", "byApp", "byUser"];
const ARRAY_FIELDS = ["activeRequests", "recentRequests", "last10Minutes", "recentCallDetails"];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedNumber(value) {
  const number = finiteNumber(value);
  return number === null ? 0 : number;
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const normalized = { ...value };
  for (const [field, fieldValue] of Object.entries(normalized)) {
    if (NUMERIC_FIELDS.has(field)) normalized[field] = normalizedNumber(fieldValue);
  }
  for (const field of ["periods", "weekdays"]) {
    if (field in value) normalized[field] = Array.isArray(value[field]) ? value[field].map(normalizedNumber) : [];
  }
  for (const field of ["models", "apps", "sourceIps"]) {
    if (field in value) normalized[field] = normalizeCounterMap(value[field]);
  }
  return normalized;
}

function normalizeCounterMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeRecord(item)]),
  );
}

/**
 * Usage snapshots can include legacy JSON values or stale Redis payloads where
 * numeric counters are serialized as strings. Normalize at the client boundary
 * so one malformed cached snapshot cannot crash the entire Usage route render.
 */
export function normalizeUsageStatsSnapshot(incoming, { partial = Boolean(incoming?.streamPatch) } = {}) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return null;

  const normalized = normalizeRecord(incoming);
  for (const field of COUNTER_MAP_FIELDS) {
    if (!partial || field in incoming) normalized[field] = normalizeCounterMap(incoming[field]);
  }
  for (const field of ARRAY_FIELDS) {
    if (!partial || field in incoming) {
      normalized[field] = Array.isArray(incoming[field])
        ? incoming[field].map((item) => normalizeRecord(item))
        : [];
    }
  }
  if (!partial || "sourceCapture" in incoming) {
    normalized.sourceCapture = incoming.sourceCapture && typeof incoming.sourceCapture === "object"
      ? incoming.sourceCapture
      : null;
  }
  return normalized;
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
