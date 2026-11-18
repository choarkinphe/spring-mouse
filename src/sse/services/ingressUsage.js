import { createHash, randomUUID } from "node:crypto";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getRequestSourceMeta } from "@/shared/utils/requestSource";
import { getTrafficRequestId } from "@/lib/networkTraffic.js";

/**
 * Persist one accepted non-chat service request with its ingress API-key
 * identity. Chat/embeddings use their richer streaming pipelines; media,
 * search, fetch, and video routes use this audit row so every billable service
 * request remains attributable even when the upstream protocol has no token
 * usage payload.
 */
export async function recordIngressUsage(request, apiKey, { model = null, response = null } = {}) {
  const now = new Date().toISOString();
  await saveRequestUsage({
    requestId: randomUUID(),
    trafficRequestId: getTrafficRequestId(request),
    startedAt: now,
    completedAt: now,
    provider: null,
    model: typeof model === "string" ? model : null,
    connectionId: null,
    apiKey,
    endpoint: new URL(request.url).pathname,
    ...getRequestSourceMeta(request),
    tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    status: response?.ok === false ? "error" : "success",
  });
}

const REJECTION_SAMPLE_WINDOW_MS = 60_000;
const REJECTION_SAMPLE_MAX_PER_PROCESS = 20;
const sampledRejections = new Set();
let sampleWindowStartedAt = null;

/** Sample policy refusals without turning a rejected burst into a write burst. */
export function recordApiKeyRejection(request, apiKey, { model, reason, startedAt }) {
  const now = Date.now();
  if (sampleWindowStartedAt === null || now - sampleWindowStartedAt >= REJECTION_SAMPLE_WINDOW_MS) {
    sampledRejections.clear();
    sampleWindowStartedAt = now;
  }
  if (sampledRejections.size >= REJECTION_SAMPLE_MAX_PER_PROCESS) return;
  const sampleKey = `${reason}:${createHash("sha256").update(apiKey).digest("hex")}`;
  if (sampledRejections.has(sampleKey)) return;
  sampledRejections.add(sampleKey);

  return saveRequestUsage({
    requestId: randomUUID(),
    trafficRequestId: getTrafficRequestId(request),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(now).toISOString(),
    model: typeof model === "string" ? model.slice(0, 256) : null,
    apiKey,
    endpoint: new URL(request.url).pathname,
    ...getRequestSourceMeta(request),
    tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    status: `blocked:${reason}`,
  });
}
