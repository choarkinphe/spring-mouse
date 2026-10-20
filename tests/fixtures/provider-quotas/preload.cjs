require("../claude-desktop-smoke/preload.cjs");
const guardedFetch = globalThis.fetch;
const windows = {
  rolling: { status: "ok", percent: 18, resetsAt: "2026-11-20T10:00:00.000Z" },
  weekly: { status: "ok", percent: 47, resetsAt: "2026-11-23T00:00:00.000Z" },
  monthly: { status: "ok", percent: 63, resetsAt: "2026-12-20T01:57:53.000Z" },
};
globalThis.fetch = function quotaFixtureFetch(input, init) {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  if (url === "https://opencode.ai/zen/go/v1/usage") return Promise.resolve(Response.json({ usage: windows }));
  if (url === "https://chatgpt.com/backend-api/wham/usage") return Promise.resolve(Response.json({
    plan_type: "pro", rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1795000000 },
      secondary_window: null,
    },
  }));
  if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") return Promise.resolve(Response.json({ available_count: 0, credits: [] }));
  if (url === "https://openapi.qoder.sh/api/v2/quota/usage") return Promise.resolve(Response.json({
    userQuota: { total: 500, used: 12.5, remaining: 487.5, unit: "credits" },
    orgResourcePackage: { total: 2000, used: 250, remaining: 1750, unit: "credits" },
    expiresAt: 1795500000000,
  }));
  if (url === "https://copilot.tencent.com/v2/billing/meter/get-user-resource") return Promise.resolve(Response.json({ code: 0, data: { Response: { Data: { Accounts: [
    { PackageName: "Monthly", CycleCapacityUsedPrecise: "275.36", CycleCapacitySizePrecise: "500", CycleEndTime: "2026-10-21T00:00:00Z", DeductionEndTime: Date.parse("2026-11-01T00:00:00Z") },
    { PackageName: "Bonus", CapacityUsedPrecise: "100", CapacitySizePrecise: "100", CycleEndTime: "2026-10-21T00:00:00Z", DeductionEndTime: Date.parse("2026-10-21T00:00:00Z") },
  ] } } } }));
  if (url?.includes("api.deepseek.com") && url.includes("user/balance")) return Promise.resolve(Response.json({
    is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42.50", granted_balance: "0.00", topped_up_balance: "42.50" }],
  }));
  return guardedFetch(input, init);
};
