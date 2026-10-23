import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getOpenCodeGoUsage } from "../../open-sse/services/usage/opencode-go.js";
import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";

const reset = "2026-10-26T00:00:00.000Z";
const fixture = (used = 25) => ({ usage: {
  rolling: { status: "ok", percent: used, resetsAt: reset },
  weekly: { status: "rate-limited", percent: 100, resetsAt: reset },
  monthly: { status: "ok", percent: 0, resetsAt: reset },
} });
afterEach(() => vi.clearAllMocks());

describe("OpenCode Go upstream quota", () => {
  it("is eligible for API-key quota display and dispatches with bearer auth and proxy", async () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("opencode-go");
    expect(USAGE_APIKEY_PROVIDERS).toContain("opencode-go");
    proxyAwareFetch.mockResolvedValueOnce(Response.json(fixture()));
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test" };
    const result = await getUsageForProvider({ provider: "opencode-go", apiKey: "test-only" }, proxy);
    expect(proxyAwareFetch).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", expect.objectContaining({
      method: "GET", headers: { Authorization: "Bearer test-only", Accept: "application/json" }, signal: expect.any(AbortSignal),
    }), proxy);
    expect(result.quotas.rolling).toMatchObject({ used: 25, total: 100, remaining: 75, unit: "%", resetAt: reset });
    expect(result.quotas.weekly).toMatchObject({ used: 100, remaining: 0 });
    expect(result.quotas.monthly).toMatchObject({ used: 0, remaining: 100 });
    expect(JSON.stringify(result)).not.toContain("test-only");
  });

  it.each([null, {}, { usage: {} }, { usage: { rolling: { percent: null, status: "ok" } } }, { usage: { rolling: { percent: "20", status: "ok" } } }, { usage: { rolling: { percent: 20, status: "new-unknown-status" } } }])("does not fabricate quota for malformed data %j", async (data) => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json(data));
    const result = await getOpenCodeGoUsage("test-only");
    expect(result.quotas).toBeUndefined();
    expect(result.message).toMatch(/no valid quota/);
  });

  it("keeps valid partial windows and does not invent missing reset times", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ usage: { monthly: { percent: 20, status: "ok" } } }));
    const result = await getOpenCodeGoUsage("test-only");
    expect(Object.keys(result.quotas)).toEqual(["monthly"]);
    expect(result.quotas.monthly).toMatchObject({ used: 20, resetAt: null });
  });

  it.each([401, 403, 429, 500, 503])("reports HTTP %s without leaking response bodies", async (status) => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ error: "private-payload" }, { status }));
    const result = await getOpenCodeGoUsage("test-only");
    expect(result.message).toContain(`HTTP ${status}`);
    expect(result.quotas).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private-payload");
  });

  it("cancels rejected response bodies to release the upstream connection", async () => {
    const cancel = vi.fn(async () => {});
    proxyAwareFetch.mockResolvedValueOnce({ ok: false, status: 429, body: { cancel } });
    await getOpenCodeGoUsage("test-only");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports transport failure without exposing credentials or proxy details", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("private-secret"));
    const result = await getOpenCodeGoUsage("test-only");
    expect(result.message).toMatch(/temporarily unavailable/);
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it("does not fetch without a key", async () => {
    expect((await getOpenCodeGoUsage(null)).message).toMatch(/requires an API key/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
