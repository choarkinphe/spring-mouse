import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY_REJECTIONS, summarizeUsageError } from "../../src/shared/utils/usageError.js";

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkApiKeyQuota: vi.fn(),
  acquireApiKeyRateSlot: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock("@/lib/localDb", () => ({
  getApiKeyByValue: async () => ({ id: "test-key-id", name: "Test" }),
  getSettings: async () => ({}),
}));
vi.mock("@/lib/apiKeyQuota.js", () => ({ checkApiKeyQuota: mocks.checkApiKeyQuota }));
vi.mock("@/lib/apiKeyRateLimit.js", () => ({
  acquireApiKeyRateSlot: mocks.acquireApiKeyRateSlot,
  resolveApiKeyRateLimit: () => ({ enabled: true, limit: 10, burst: 1, queueTimeoutMs: 15_000 }),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

const { authorizeApiKey } = await import("../../src/sse/services/auth.js");

const diagnostic = "Upstream rejected the Claude Code version";
const rateStatus = `blocked:${API_KEY_REJECTIONS.RATE_LIMIT}`;

describe("summarizeUsageError", () => {
  it("recognizes nested error bodies without retaining the original text", () => {
    const body = JSON.stringify({ error: { message: "Claude Code 2.1.92 does not support this model; private prompt" } });
    expect(summarizeUsageError(JSON.stringify({ error: body, status: 400 }))).toBe(diagnostic);
    expect(summarizeUsageError({ error: { message: "Our servers are overloaded; signed URL" } })).toBe("Upstream service overloaded or unavailable");
    expect(summarizeUsageError(new Error("fetch failed"))).toBe("Upstream connection failed");
  });

  it("never returns fragments of unexpected text", () => {
    const body = "<html>private prompt, token, and signed URL</html>";
    const generic = "Request failed; see the request detail or gateway logs for diagnostics";
    expect(summarizeUsageError(body)).toBe(generic);
    expect(summarizeUsageError("x".repeat(8192) + "fetch failed")).toBe(generic);
    expect(summarizeUsageError(null)).toBeNull();
    expect(summarizeUsageError("   ")).toBeNull();
    expect(summarizeUsageError({})).toBeNull();
    expect(summarizeUsageError(body, "cancelled")).toBeNull();
    expect(summarizeUsageError(null, rateStatus)).toBe("API key request rate limit reached");
  });
});

describe("API-key admission diagnostics", () => {
  const request = new Request("http://localhost/v1/embeddings");
  let now = 1_800_000_000_000;
  beforeEach(() => {
    vi.clearAllMocks();
    now += 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.validateApiKey.mockResolvedValue(true);
    mocks.checkApiKeyQuota.mockResolvedValue({ allowed: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("records a non-chat quota refusal without charging the rate slot", async () => {
    mocks.checkApiKeyQuota.mockResolvedValueOnce({ allowed: false, status: {} });
    const response = await authorizeApiKey("test-quota-key", { request });
    expect(response.status).toBe(429);
    expect(response.__smRejection).toBe(API_KEY_REJECTIONS.QUOTA);
    expect((await response.json()).error.code).toBe("api_key_quota_exceeded");
    expect(mocks.acquireApiKeyRateSlot).not.toHaveBeenCalled();
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "test-quota-key", endpoint: "/v1/embeddings", status: "blocked:api_key_quota",
      tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
  });

  it("distinguishes quota from rate refusals and includes the wait time", async () => {
    mocks.checkApiKeyQuota.mockResolvedValueOnce({ allowed: false, status: {} });
    mocks.acquireApiKeyRateSlot.mockImplementation(async () => {
      now += 15_000;
      return { allowed: false, reason: "queue_timeout", waitedMs: 15_000 };
    });
    await authorizeApiKey("test-rate-key", { request, meter: true });
    const response = await authorizeApiKey("test-rate-key", { request, meter: true, model: "embedding-model" });
    expect(response.status).toBe(429);
    expect(response.__smRejection).toBe(API_KEY_REJECTIONS.RATE_LIMIT);
    expect((await response.json()).error.code).toBe("api_key_rate_limited");
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(2);
    const row = mocks.saveRequestUsage.mock.calls[1][0];
    expect(row).toMatchObject({ status: rateStatus, model: "embedding-model" });
    expect(Date.parse(row.completedAt) - Date.parse(row.startedAt)).toBe(15_000);
  });

  it("samples once per key and reason, with a process-wide cap that renews", async () => {
    mocks.acquireApiKeyRateSlot.mockResolvedValue({ allowed: false, reason: "rate_limit" });
    for (let i = 0; i < 3; i += 1) await authorizeApiKey("test-repeat-key", { request, meter: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 22; i += 1) await authorizeApiKey(`test-key-${i}`, { request, meter: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(20);
    now += 60_000;
    await authorizeApiKey("test-repeat-key", { request, meter: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(21);
  });

  it("never samples invalid or missing credentials or a cancelled queue wait", async () => {
    mocks.validateApiKey.mockResolvedValueOnce(false);
    const invalid = await authorizeApiKey("test-invalid-key", { request, requireApiKey: true });
    const missing = await authorizeApiKey(null, { request, requireApiKey: true });
    mocks.acquireApiKeyRateSlot.mockResolvedValueOnce({ allowed: false, reason: "aborted" });
    const aborted = await authorizeApiKey("test-valid-key", { request, meter: true });
    expect([invalid.status, missing.status, aborted.status]).toEqual([401, 401, 499]);
    expect([invalid, missing, aborted].map((r) => r.__smRejection)).toEqual([undefined, undefined, undefined]);
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
});
