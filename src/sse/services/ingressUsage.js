import { randomUUID } from "node:crypto";
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
