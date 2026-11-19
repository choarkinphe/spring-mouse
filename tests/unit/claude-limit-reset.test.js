import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { parseLimitResetStatus, claimClaudeLimitReset, getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ORG = "11111111-2222-3333-4444-555555555555";

beforeEach(() => fetchMock.mockReset());

describe("parseLimitResetStatus", () => {
  it("returns null when neither program is reported", () => {
    expect(parseLimitResetStatus({ five_hour: {} })).toBeNull();
  });

  it("counts usable reset cards and keeps the next grant id", () => {
    const status = parseLimitResetStatus({
      cedar_ember: {
        eligible: true, at_limit: true, next_grant_id: "g1",
        grants: [
          { id: "g1", resets_left: 2, resets_total: 3, paused: false },
          { id: "g2", resets_left: 1, paused: true },
          { id: "BAD ID", resets_left: 5 },
        ],
      },
      juniper_tide: { eligible: false, ineligible_reason: "not_at_wall", available: false },
    });
    expect(status.grants.available).toBe(2);
    expect(status.grants.nextGrantId).toBe("g1");
    expect(status.grants.items.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(status.weekly).toMatchObject({ eligible: false, ineligibleReason: "not_at_wall" });
  });
});

describe("Claude usage quotas", () => {
  it("shows model-scoped weekly limits that only appear in limits[]", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {
      five_hour: { utilization: 8, resets_at: null },
      seven_day: { utilization: 16, resets_at: null },
      limits: [{ kind: "weekly_scoped", percent: 40, resets_at: null, scope: { model: { display_name: "Fable" } } }],
    }));
    const usage = await getClaudeUsage("tok-scoped", null, { force: true });
    expect(usage.quotas["weekly fable (7d)"]).toMatchObject({ used: 40, remaining: 60 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("at_wall=1");
    expect(init.headers["User-Agent"]).toMatch(/^claude-cli\//);
  });
});

describe("claimClaudeLimitReset", () => {
  it("claims a reset card against the account's organization", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { organization: { uuid: ORG } }))
      .mockResolvedValueOnce(json(200, { result: "reset", resets_left: 1, cleared: ["five_hour"] }));
    const out = await claimClaudeLimitReset("tok", { program: "grant", grantId: "g1", requestId: "req-1" });
    expect(out).toMatchObject({ ok: true, result: "reset", resetsLeft: 1, cleared: ["five_hour"] });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`);
    expect(JSON.parse(init.body)).toEqual({ program: "cedar_ember", grant_id: "g1", request_id: "req-1" });
  });

  it("uses the weekly session reset program", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { organization: { uuid: ORG } }))
      .mockResolvedValueOnce(json(200, { result: "not_limited" }));
    const out = await claimClaudeLimitReset("tok", { program: "weekly" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ program: "juniper_tide" });
    expect(out).toMatchObject({ ok: false, result: "not_limited" });
    expect(out.message).toContain("未触及");
  });

  it("maps 429 and auth failures without claiming success", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { organization: { uuid: ORG } }))
      .mockResolvedValueOnce(json(429, {}));
    expect((await claimClaudeLimitReset("tok", { program: "weekly" })).result).toBe("rate_limited");
    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect((await claimClaudeLimitReset("tok", { program: "weekly" })).result).toBe("auth_error");
  });

  it("refuses a malformed grant id before any request", async () => {
    await expect(claimClaudeLimitReset("tok", { program: "grant", grantId: "../x", requestId: "r" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
