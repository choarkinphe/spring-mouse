const STAGES = new Set(["setup", "http-smoke", "cancellation", "routing-dedupe", "persistence"]);
const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
// Endpoint labels are allowlisted paths, never response text: a failed dashboard
// API is named by its path only, so no payload fragment can reach an annotation.
const endpoint = (value) => typeof value === "string" && /^\/api\/[A-Za-z0-9@/_-]{0,80}$/.test(value) ? value : "unknown";

export function summarizeSmokeFailure(stage, stdout = "", stderr = "") {
  const summary = { stage: STAGES.has(stage) ? stage : "unknown" };
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    let data;
    try { data = JSON.parse(line); } catch { continue; }
    if (data?.check === "smoke-persistence") {
      summary.persistence = Object.fromEntries(["usageRows", "attempts", "completedAttempts", "selectedAccounts"].map((key) => [key, number(data.counts?.[key])]));
    }
    if (data?.check === "routing-delivery") {
      summary.delivery = Object.fromEntries(["enqueued", "sent", "failed", "retried", "droppedQueueFull", "droppedInvalid", "droppedBytes"].map((key) => [key, number(data.health?.[key])]));
    }
    if (data?.event === "smoke.http.failure" && (data.endpoint !== undefined || data.status !== undefined || data.category !== undefined)) {
      summary.http = {
        endpoint: endpoint(data.endpoint),
        status: number(data.status),
        ...(data.category !== undefined
          ? { category: ["sqlite-busy", "sqlite-locked", "sqlite-error", "filesystem", "network", "request-json", "cookie-context", "crypto", "type-error"].includes(data.category) ? data.category : "unknown" }
          : {}),
      };
    }
  }
  const status = stderr.match(/AssertionError[^\n]*: (\/api\/[A-Za-z0-9@/_-]{0,80}): HTTP (\d{3})/);
  if (status && !summary.http) summary.http = { endpoint: endpoint(status[1]), status: Number(status[2]), category: "unknown" };
  const location = stderr.match(/at .*?\/release-smoke\/(verify|cancellation|read-db|routing-dedupe)\.mjs:(\d+):(\d+)/);
  if (location) summary.location = { file: `${location[1]}.mjs`, line: Number(location[2]) };
  return summary;
}

export function smokeFailureAnnotation(summary) {
  return `::error title=Isolated smoke failure::${JSON.stringify(summarizeSafeSummary(summary))}`;
}

function summarizeSafeSummary(summary) {
  // Round-trip through the allowlist even when a caller passes arbitrary data.
  const normalized = summarizeSmokeFailure(summary.stage,
    JSON.stringify({ check: "smoke-persistence", counts: summary.persistence }) + "\n" +
    JSON.stringify({ check: "routing-delivery", health: summary.delivery }) + "\n" +
    JSON.stringify({ event: "smoke.http.failure", ...summary.http }));
  if (!summary.persistence) delete normalized.persistence;
  if (!summary.delivery) delete normalized.delivery;
  if (!summary.http) delete normalized.http;
  if (["verify.mjs", "cancellation.mjs", "read-db.mjs", "routing-dedupe.mjs"].includes(summary.location?.file)) {
    normalized.location = { file: summary.location.file, line: number(summary.location.line) };
  }
  return normalized;
}
