import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  updateProviderConnectionHealth: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { clearAccountError } = await import("../../src/sse/services/auth.js");

const EXPIRED_LOCK = "2020-01-01T00:00:00.000Z";
const UPSTREAM_SNAPSHOT = {
  lastUpstreamError: "The usage limit has been reached",
  lastUpstreamStatus: 429,
  lastUpstreamSource: "http",
  lastUpstreamRaw: "raw provider body",
  lastUpstreamAt: "2026-09-01T00:00:00.000Z",
};

function mockConnection(overrides = {}) {
  const conn = { id: "acct-a", provider: "codex", name: "acct-a", ...overrides };
  dbMocks.updateProviderConnectionHealth.mockImplementation(async (_id, updater) => {
    const result = updater(conn);
    if (result?.update) dbMocks.updateProviderConnection("acct-a", result.update);
    return result?.value || null;
  });
  return conn;
}

function lastUpdate() {
  const calls = dbMocks.updateProviderConnection.mock.calls;
  return calls.length ? calls.at(-1)[1] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnectionById.mockResolvedValue(null);
  dbMocks.getProviderConnections.mockResolvedValue([]);
});

describe("clearAccountError drops the stale upstream snapshot", () => {
  it("clears the lastUpstream fields once the account has fully recovered", async () => {
    mockConnection({
      testStatus: "limited",
      lastError: "The usage limit has been reached",
      lastErrorAt: "2026-09-01T00:00:00.000Z",
      errorCode: 429,
      "modelLock_gpt-5": EXPIRED_LOCK,
      ...UPSTREAM_SNAPSHOT,
    });

    await clearAccountError("acct-a", { _routingStartedAt: 0 }, "gpt-5");

    expect(lastUpdate()).toEqual(expect.objectContaining({
      testStatus: "active",
      lastError: null,
      errorCode: null,
      backoffLevel: 0,
      lastUpstreamError: null,
      lastUpstreamStatus: null,
      lastUpstreamSource: null,
      lastUpstreamRaw: null,
      lastUpstreamAt: null,
    }));
  });

  it("keeps the snapshot while another model is still locked", async () => {
    const activeLock = new Date(Date.now() + 60_000).toISOString();
    mockConnection({
      testStatus: "limited",
      lastError: "The usage limit has been reached",
      lastErrorAt: "2026-09-01T00:00:00.000Z",
      errorCode: 429,
      "modelLock_gpt-5": EXPIRED_LOCK,
      "modelLock_gpt-4": activeLock,
      ...UPSTREAM_SNAPSHOT,
    });

    await clearAccountError("acct-a", { _routingStartedAt: 0 }, "gpt-5");

    const update = lastUpdate();
    expect(update).toEqual({ "modelLock_gpt-5": null });
    expect(update).not.toHaveProperty("lastUpstreamError");
    expect(update).not.toHaveProperty("testStatus");
  });

  it("cleans up rows left healthy by an older build", async () => {
    mockConnection({
      testStatus: "active",
      lastError: null,
      ...UPSTREAM_SNAPSHOT,
    });

    await clearAccountError("acct-a", { _routingStartedAt: 0 }, "gpt-5");

    expect(lastUpdate()).toEqual(expect.objectContaining({ lastUpstreamError: null }));
  });

  it("stays a no-op for a fully clean account", async () => {
    mockConnection({ testStatus: "active" });

    await clearAccountError("acct-a", { _routingStartedAt: 0 }, "gpt-5");

    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
