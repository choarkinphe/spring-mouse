// The account-selection decision used to be debug-only.
//
// At the production default LOG_LEVEL=WARN operators could read
// "all 4 accounts locked for gpt-5" but never learn *which* account was
// skipped, *why* (excluded / locked / node offline), or *which request* the
// decision belonged to — the per-account detail was a `log.debug` that the
// level filter dropped, and nothing carried a request id.
//
// These tests pin the always-visible replacement: one routeLine per selection
// (routeLine bypasses LOG_LEVEL) carrying the available count, every skip
// reason, the account id and the correlation prefix.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelLockUpdate } from "../../open-sse/services/accountFallback.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getSettings: vi.fn(),
  getMouses: vi.fn(async () => []),
  updateProviderConnection: vi.fn(),
  routeLine: vi.fn(),
  reserve: vi.fn(),
  proxy: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyByValue: vi.fn(),
  getProviderConnections: mocks.getProviderConnections,
  getProviderConnectionById: mocks.getProviderConnectionById,
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getMouses: mocks.getMouses,
  getMouseExecutionDetails: vi.fn(async () => null),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/redis/connectionSlots.js", () => ({
  reserveConnectionSlot: mocks.reserve,
  getConnectionConcurrencyLimit: () => 16,
  getLocalSlotStatus: () => ({ active: 0, redis: 0, queued: 0 }),
  estimateRequestWeight: () => 1,
}));
vi.mock("@/lib/apiKeyQuota.js", () => ({ checkApiKeyQuota: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  routeLine: mocks.routeLine,
  tagForSession: vi.fn(() => "🟢"),
  maskKey: vi.fn((key) => `masked:${key}`),
}));

const { getProviderCredentials, resetProviderUserAssignments } =
  await import("../../src/sse/services/auth.js");

const connection = (id, extra = {}) => ({
  id, provider: "openai", apiKey: `upstream-${id}`, isActive: true, priority: 1, providerSpecificData: {}, ...extra,
});

/** The 🎯 selection line emitted for each routing decision. */
const routingLine = () => {
  const call = mocks.routeLine.mock.calls.find(([, symbol]) => symbol === "🎯");
  return call ? { color: call[0], message: call[2] } : null;
};

describe("routing decision visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderUserAssignments();
    mocks.proxy.mockResolvedValue({ connectionProxyEnabled: false });
    mocks.getProviderConnectionById.mockResolvedValue(null);
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, modelAccessTags: {} });
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("publishes the available count and the request id on an always-visible line", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("aaaabbbbcccc"), connection("dddd55556666")]);

    await getProviderCredentials("openai", null, "gpt-5", { requestId: "req12345678-rest" });

    const line = routingLine();
    expect(line).toBeTruthy();
    expect(line.color).toBe("🟢");
    expect(line.message).toContain("[req12345]");
    expect(line.message).toContain("available 2/2");
    expect(line.message).not.toContain("skipped");
  });

  it("names the locked account instead of hiding it behind debug", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("aaaabbbbcccc"),
      { ...connection("dddd55556666"), ...buildModelLockUpdate("gpt-5", 120_000) },
    ]);

    await getProviderCredentials("openai", null, "gpt-5", { requestId: "req99999999-rest" });

    const line = routingLine();
    expect(line.color).toBe("🟢");
    expect(line.message).toContain("available 1/2");
    expect(line.message).toContain("dddd5555:locked(gpt-5)");
    // The healthy account must not be reported as skipped.
    expect(line.message).not.toContain("aaaabbbb:locked");
    expect(line.message).not.toContain("aaaabbbb:excluded");
  });

  it("turns red and names exclusions when nothing is left", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("aaaabbbbcccc")]);

    const result = await getProviderCredentials(
      "openai", new Set(["aaaabbbbcccc"]), "gpt-5", { requestId: "req00000000-rest" },
    );

    expect(result).toBeNull();
    const line = routingLine();
    expect(line.color).toBe("🔴");
    expect(line.message).toContain("[req00000]");
    expect(line.message).toContain("available 0/1");
    expect(line.message).toContain("aaaabbbb:excluded");
  });

  it("omits the prefix when the caller supplies no request id", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("aaaabbbbcccc")]);

    await getProviderCredentials("openai", null, "gpt-5", {});

    expect(routingLine().message).not.toContain("[");
  });
});
