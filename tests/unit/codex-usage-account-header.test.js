import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

// A wham/usage payload with one primary + one secondary window.
function usagePayload(overrides = {}) {
  return {
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 12, reset_at: "2026-10-01T00:00:00.000Z" },
      secondary_window: { used_percent: 3, reset_at: "2026-10-07T00:00:00.000Z" },
    },
    ...overrides,
  };
}

describe("getCodexUsage account scoping", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => usagePayload(),
    });
  });

  it("sends ChatGPT-Account-ID (plus the Codex client headers) when providerSpecificData carries one", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    await getCodexUsage("token", { strictProxy: false }, {
      providerSpecificData: { chatgptAccountId: "acct_123" },
    });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/wham/usage"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          Accept: "application/json",
          "OpenAI-Beta": "codex-1",
          originator: "codex_cli_rs",
          "ChatGPT-Account-ID": "acct_123",
        }),
      }),
      { strictProxy: false },
    );
  });

  it("prefers workspaceId over chatgptAccountId, matching the reset-credits path", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    await getCodexUsage("token", null, {
      providerSpecificData: { workspaceId: "ws_1", chatgptAccountId: "acct_2" },
    });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/wham/usage"),
      expect.objectContaining({
        headers: expect.objectContaining({ "ChatGPT-Account-ID": "ws_1" }),
      }),
      null,
    );
  });

  it("omits the header (without throwing) when no account id is available", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    await getCodexUsage("token");

    const [, init] = mocks.proxyAwareFetch.mock.calls[0];
    expect(init.headers).not.toHaveProperty("ChatGPT-Account-ID");
  });

  it("returns a soft-failure message and logs the status when upstream is not ok", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalidated oauth token",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexUsage("token", null, {
      providerSpecificData: { chatgptAccountId: "acct_123" },
    });

    expect(result).toEqual({ message: "Codex connected. Usage API temporarily unavailable (401)." });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("accountId=yes"));
    warn.mockRestore();
  });

  it("warns when a 200 carries no quota window at all", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ plan_type: "pro" }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexUsage("token");

    expect(result.quotas).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no quota windows"));
    warn.mockRestore();
  });
});
