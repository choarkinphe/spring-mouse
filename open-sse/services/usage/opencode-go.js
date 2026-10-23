import { parseResetTime, U } from "./shared.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

// Source-backed Console endpoint, not a documented stable public quota API.
// Its percentages are used allowance, never token or monetary balances.
export async function getOpenCodeGoUsage(apiKey, proxyOptions = null) {
  if (!apiKey) return { message: "OpenCode Go usage requires an API key." };
  try {
    const config = U("opencode-go");
    // Keep the deadline alive through JSON consumption, not just response headers.
    const response = await proxyAwareFetch(config.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    }, proxyOptions);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { message: `OpenCode Go usage temporarily unavailable (HTTP ${response.status}).` };
    }
    const data = await response.json();
    const quotas = {};
    for (const [key, displayName] of Object.entries(config.windows || {})) {
      const window = data?.usage?.[key];
      if (!window || typeof window.percent !== "number" || !Number.isFinite(window.percent)) continue;
      if (!["ok", "rate-limited"].includes(window.status)) continue;
      const used = Math.max(0, Math.min(100, window.percent));
      quotas[key] = {
        displayName, used, total: 100, remaining: 100 - used,
        unit: "%", unlimited: false, resetAt: parseResetTime(window.resetsAt),
      };
    }
    if (!Object.keys(quotas).length) return { message: "OpenCode Go usage returned no valid quota windows." };
    return { quotas };
  } catch {
    // Never surface arbitrary provider bodies, proxy URLs, or credentials.
    return { message: "OpenCode Go usage temporarily unavailable." };
  }
}
