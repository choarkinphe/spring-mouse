import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

describe("Codex usage percentage units", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("labels normal and review session/weekly windows as percentages", async () => {
    const resetAt = "2026-10-21T00:00:00.000Z";
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 25, reset_at: resetAt },
          secondary_window: { used_percent: 60, reset_at: resetAt },
        },
        code_review_rate_limit: {
          primary_window: { used_percent: 10, reset_at: resetAt },
          secondary_window: { used_percent: 80, reset_at: resetAt },
        },
      }),
    });

    const { quotas } = await getCodexUsage("test-token");

    expect(Object.keys(quotas).sort()).toEqual([
      "review_session", "review_weekly", "session", "weekly",
    ]);
    for (const [key, used] of Object.entries({
      session: 25, weekly: 60, review_session: 10, review_weekly: 80,
    })) {
      expect(quotas[key]).toEqual({
        used,
        total: 100,
        remaining: 100 - used,
        unit: "%",
        resetAt,
        unlimited: false,
      });
    }
  });

  it("keeps legacy primary keys while exposing the actual seven-day duration", async () => {
    proxyAwareFetch.mockResolvedValue(Response.json({ rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1793082723 },
      secondary_window: null,
    } }));
    const { quotas } = await getCodexUsage("test-token");
    expect(Object.keys(quotas)).toEqual(["session"]);
    expect(quotas.session).toMatchObject({ used: 0, remaining: 100, windowSeconds: 604800 });
  });

  it.each([{}, { used_percent: null }, { used_percent: "" }, { used_percent: "bad" }, { used_percent: false }])("does not turn an unknown percentage into unused quota: %j", async window => {
    proxyAwareFetch.mockResolvedValue(Response.json({ rate_limit: { primary_window: window } }));
    const { quotas } = await getCodexUsage("test-token");
    expect(quotas).toEqual({});
  });

  it("preserves percentage units when clamping aliased percentage values", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        rate_limits: {
          primary: { percent_used: -5 },
          secondary: { percent_used: 120 },
        },
      }),
    });

    const { quotas } = await getCodexUsage("test-token");

    expect(quotas.session).toEqual({
      used: 0, total: 100, remaining: 100, unit: "%", resetAt: null, unlimited: false,
    });
    expect(quotas.weekly).toEqual({
      used: 100, total: 100, remaining: 0, unit: "%", resetAt: null, unlimited: false,
    });
  });
});
