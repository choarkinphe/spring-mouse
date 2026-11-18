import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeUsageError, USAGE_ERROR_MAX_CHARS } from "../../src/shared/utils/usageError.js";

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkApiKeyQuota: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock("@/lib/apiKeyQuota.js", () => ({ checkApiKeyQuota: mocks.checkApiKeyQuota }));

const { authorizeApiKey, API_KEY_REJECTIONS } = await import("../../src/sse/services/auth.js");

describe("summarizeUsageError", () => {
  it("unwraps the message nested in an Anthropic error body (JSON inside a string)", () => {
    // Shape observed in production for the stale Claude Code version rejection.
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Claude Code 2.1.92 does not support this model; version 2.1.280 or newer is required." },
    });
    expect(summarizeUsageError(JSON.stringify({ error: body, status: 400 })))
      .toBe("Claude Code 2.1.92 does not support this model; version 2.1.280 or newer is required.");
  });

  it("reads Error objects, OpenAI-style objects and plain text", () => {
    expect(summarizeUsageError(new Error("fetch failed"))).toBe("fetch failed");
    expect(summarizeUsageError({ error: { message: "Our servers are overloaded" } })).toBe("Our servers are overloaded");
    expect(summarizeUsageError("  upstream\n timed out  ")).toBe("upstream timed out");
  });

  it("strips markup and control characters and clamps the length", () => {
    expect(summarizeUsageError("<html><title>502 Bad Gateway</title></html>")).toBe("502 Bad Gateway");
    const long = summarizeUsageError("x".repeat(USAGE_ERROR_MAX_CHARS * 2));
    expect(long.length).toBe(USAGE_ERROR_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns null when there is nothing to say", () => {
    expect(summarizeUsageError(null)).toBeNull();
    expect(summarizeUsageError("   ")).toBeNull();
    expect(summarizeUsageError({})).toBeNull();
  });
});

describe("API-key rejections are tagged with the limit that refused them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiKey.mockResolvedValue(true);
    mocks.checkApiKeyQuota.mockResolvedValue({ allowed: true });
  });

  it("tags a quota refusal of a valid key", async () => {
    mocks.checkApiKeyQuota.mockResolvedValueOnce({
      allowed: false,
      status: { exceededWindow: { label: "5h", resetAt: new Date(Date.now() + 60_000).toISOString() } },
    });
    const response = await authorizeApiKey("sk-valid-key-123456", { requireApiKey: true });
    expect(response.status).toBe(429);
    expect(response.__smRejection).toBe(API_KEY_REJECTIONS.QUOTA);
    expect((await response.json()).error.code).toBe("api_key_quota_exceeded");
  });

  it("leaves an invalid or missing key untagged, so it never becomes a usage row", async () => {
    mocks.validateApiKey.mockResolvedValueOnce(false);
    const invalid = await authorizeApiKey("sk-unknown", { requireApiKey: true });
    expect(invalid.status).toBe(401);
    expect(invalid.__smRejection).toBeUndefined();

    const missing = await authorizeApiKey(null, { requireApiKey: true });
    expect(missing.status).toBe(401);
    expect(missing.__smRejection).toBeUndefined();
  });
});
