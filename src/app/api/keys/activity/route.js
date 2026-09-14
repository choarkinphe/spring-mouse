import { NextResponse } from "next/server";
import { getApiKeys, getSettings } from "@/lib/localDb";
import { API_KEY_RATE_WINDOW_MS, getApiKeyLiveSnapshot, resolveApiKeyRateLimit } from "@/lib/apiKeyRateLimit";

export const dynamic = "force-dynamic";

// GET /api/keys/activity - live per-key request activity.
//
// Mirrors /api/providers/concurrency: one small payload the credentials page
// polls on its own, so refreshing the live column never drags the key list,
// its quotas and the settings blob along. Both numbers come from the same
// process-local counters that admission uses (see apiKeyRateLimit.js), which is
// how the channel list reports its own concurrency.
//
// `requests` is counted inside the rolling window the allowance is expressed
// in, so "3 / 6" means the same thing here as it does in the limit dialog.
export async function GET() {
  try {
    const [keys, settings] = await Promise.all([getApiKeys(), getSettings()]);
    const live = getApiKeyLiveSnapshot();
    const payload = {};

    for (const key of keys) {
      const rules = resolveApiKeyRateLimit(key, settings?.apiKeyRateLimitRules);
      const activity = live[key.id];
      payload[key.id] = {
        enabled: rules.enabled,
        limit: rules.limit,
        queueMax: rules.queueMax,
        queueTimeoutMs: rules.queueTimeoutMs,
        windowMs: API_KEY_RATE_WINDOW_MS,
        requests: activity?.requests || 0,
        queued: activity?.queued || 0,
        lastAt: activity?.lastAt || key.lastUsedAt || null,
        lastModel: activity?.lastModel || null,
        models: activity?.models || [],
      };
    }

    return NextResponse.json({ keys: payload }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error reading API key activity:", error);
    return NextResponse.json({ error: "Failed to read API key activity" }, { status: 500 });
  }
}
