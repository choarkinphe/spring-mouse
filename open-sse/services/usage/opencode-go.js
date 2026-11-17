import { parseResetTime, U } from "./shared.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

// Source-backed Console endpoint, not a documented stable public quota API.
// Its percentages are used allowance, never token or monetary balances.
// Docs (opencode.ai/docs/go): limits are monthly dollar amounts per model;
// 5-hour = 20% and weekly = 50% of the monthly value, monthly = 100%.
// Window shares are plan-invariant, so the per-plan monthly allowance table
// in the registry converts each window's percent into dollars.

const GO_PLANS = new Set(["go", "go-plus", "go-teams"]);

// The API reports account-wide window percentages, not per-model rows, so a
// per-model dollar total cannot be derived from the response. When a plan is
// known, summarize it with the largest monthly allowance that plan offers —
// the smallest allowance would look artificially exhausted at high usage.
function largestMonthlyAllowance(planLimits) {
  let max = null;
  for (const value of Object.values(planLimits || {})) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

function dollarTotals(plan, config) {
  if (!GO_PLANS.has(plan)) return null;
  const monthly = largestMonthlyAllowance(config.planLimits?.[plan]);
  if (monthly === null) return null;
  const shares = config.windowShare || {};
  return {
    monthly,
    rolling: typeof shares.rolling === "number" ? monthly * shares.rolling : null,
    weekly: typeof shares.weekly === "number" ? monthly * shares.weekly : null,
  };
}

export async function getOpenCodeGoUsage(apiKey, providerSpecificData = null, proxyOptions = null) {
  if (!apiKey) return { message: "OpenCode Go usage requires an API key." };
  try {
    const config = U("opencode-go");
    const totals = dollarTotals(
      typeof providerSpecificData?.goPlan === "string" ? providerSpecificData.goPlan : "",
      config,
    );
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
      // Dollar conversion is a ceiling summary per plan, so the percentage row
      // stays the source of truth for per-window progress.
      const total = totals?.[key];
      quotas[key] = {
        displayName, used, total: 100, remaining: 100 - used,
        ...(total ? { usedUsd: total * used / 100, totalUsd: total, currency: "USD" } : {}),
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
