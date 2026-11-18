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

/**
 * Persist one request that a *valid* API key had refused by its own quota or
 * request-rate limit (see API_KEY_REJECTIONS in ./auth.js). The row carries
 * `blocked:<reason>` and the client-facing message, so the console names the
 * key and the limit instead of an unattributed 429. Fire-and-forget: recording
 * must never delay or change the rejection itself.
 */
export function recordApiKeyRejection(request, apiKey, { model = null, endpoint = null, reason, response = null } = {}) {
  const now = new Date().toISOString();
  const read = response?.clone ? response.clone().json().catch(() => null) : Promise.resolve(null);
  read.then((payload) => saveRequestUsage({
    requestId: randomUUID(),
    trafficRequestId: getTrafficRequestId(request),
    startedAt: now,
    completedAt: now,
    provider: null,
    model: typeof model === "string" ? model : null,
    connectionId: null,
    apiKey,
    endpoint: endpoint || (() => { try { return new URL(request.url).pathname; } catch { return null; } })(),
    ...getRequestSourceMeta(request),
    tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    status: `blocked:${reason}`,
    error: payload || reason,
  })).catch(() => {});
}
