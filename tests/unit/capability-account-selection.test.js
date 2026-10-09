import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceMeasuredCapabilityOverrides } from "open-sse/providers/capabilities.js";
const mocks = vi.hoisted(() => ({ accounts: [], reserve: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => mocks.accounts,
  getSettings: async () => ({ providerStrategies: {} }),
  getMouses: async () => [],
  getMouseExecutionDetails: async () => null,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("@/lib/redis/connectionSlots.js", () => ({ reserveConnectionSlot: mocks.reserve, getConnectionConcurrencyLimit: () => 2, estimateRequestWeight: () => 1 }));
vi.mock("@/sse/services/providerBreaker.js", () => ({ getProviderModelBreaker: async () => ({}), getModelOverloadThrottle: async () => ({}) }));
const { getProviderCredentials } = await import("@/sse/services/auth.js");
const account = (id, extra = {}) => ({ id, provider: "openai", apiKey: id, ...extra });
beforeEach(() => {
  mocks.accounts = [account("text"), account("vision")];
  mocks.reserve.mockImplementation(async (candidates) => ({ connectionId: candidates[0].id, release: mocks.release }));
  replaceMeasuredCapabilityOverrides({ connections: [
    { provider: "openai", model: "m", connectionId: "text", capabilities: { vision: false } },
    { provider: "openai", model: "m", connectionId: "vision", capabilities: { vision: true } },
  ] });
});
describe("capability-aware account allocation", () => {
  it("filters unsupported accounts before reserving a slot", async () => {
    const credentials = await getProviderCredentials("openai", null, "m", { requiredCapabilities: new Set(["vision"]), reserveSlot: true });
    expect(credentials.connectionId).toBe("vision");
    expect(mocks.reserve.mock.calls.at(-1)[0]).toEqual([{ id: "vision", limit: 2 }]);
  });
  it("prefers a verified-capable account over an untested priority account", async () => {
    replaceMeasuredCapabilityOverrides({ connections: [{ provider: "openai", model: "m", connectionId: "vision", capabilities: { vision: true } }] });
    expect((await getProviderCredentials("openai", null, "m", { requiredCapabilities: new Set(["vision"]) })).connectionId).toBe("vision");
  });
  it("pins probes strictly instead of applying normal account fallback", async () => {
    const credentials = await getProviderCredentials("openai", null, "m", { strictConnectionId: "text", reserveSlot: true });
    expect(credentials.connectionId).toBe("text");
    mocks.accounts[0]["modelLock_m"] = new Date(Date.now() + 30000).toISOString();
    expect(await getProviderCredentials("openai", null, "m", { strictConnectionId: "text" })).toMatchObject({ pinnedUnavailable: true });
  });
  it("returns an explicit capability failure when all accounts reject the input", async () => {
    replaceMeasuredCapabilityOverrides({ connections: mocks.accounts.map((a) => ({ provider: "openai", model: "m", connectionId: a.id, capabilities: { vision: false } })) });
    expect(await getProviderCredentials("openai", null, "m", { requiredCapabilities: new Set(["vision"]) })).toMatchObject({ capabilityUnavailable: true });
  });
});
