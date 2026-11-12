// Exercise the real ingress and nested-combo executor, without real credentials,
// quota storage or upstream traffic. A member quota is not a whole-key quota.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  gate: vi.fn(),
  core: vi.fn(),
  credentials: vi.fn(),
  combo: vi.fn(),
  combos: vi.fn(),
  entries: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../src/sse/services/auth.js", async () => {
  const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
  return ({
  extractApiKey: () => "test-key",
  authorizeApiKey: mocks.authorize,
  resolveApiKeyAccessTags: async () => [],
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: vi.fn(async (_id, status, error) => checkFallbackError(status, error)),
  clearAccountError: vi.fn(async () => {}),
  });
});
vi.mock("@/lib/apiKeyQuota.js", () => ({ getComboMemberQuotaGate: mocks.gate }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ comboStrategies: {} }),
  getComboByName: mocks.combo,
  getCombos: mocks.combos,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getComboModelEntries: mocks.entries,
  getModelInfo: async (id) => {
    const slash = id.indexOf("/");
    return slash < 0
      ? { provider: null, model: id }
      : { provider: id.slice(0, slash), model: id.slice(slash + 1) };
  },
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("@/lib/modelCapabilityOverrides", () => ({ refreshModelCapabilityOverrides: async () => {} }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("../../src/sse/services/routingTelemetry.js", () => ({
  createRoutingTelemetrySession: () => ({
    open() {}, hint() {}, setTerminalReason() {}, complete() {},
    completeFromResponse() {}, finalize() {}, openAttempt() { return null; },
  }),
  attemptTerminalFromResult: () => ({}),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
let graph, exhausted;

function request() {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
    body: JSON.stringify({ model: "gpt-6-astra", stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  graph = [
    { name: "gpt-6-astra", models: [
      { model: "cx/gpt-6-astra", quota: { fiveHourTokenLimitM: 50, weeklyTokenLimitM: 500 } },
      { model: "gpt-6.1-sol" },
    ] },
    { name: "gpt-6.1-sol", models: [{ model: "cx/gpt-6.1-sol" }] },
  ];
  exhausted = new Set(["cx/gpt-6-astra"]);
  mocks.authorize.mockResolvedValue(null);
  mocks.combo.mockImplementation(async (name) => graph.find((combo) => combo.name === name));
  mocks.combos.mockImplementation(async () => graph);
  mocks.entries.mockImplementation(async (name) => graph.find((combo) => combo.name === name)?.models || null);
  mocks.gate.mockImplementation(async () => ({
    isExhausted: (id) => exhausted.has(id),
    exhaustedFor: (id) => exhausted.has(id)
      ? { id, exceededWindow: { id: "fiveHour", resetAt: "2099-01-01T00:00:00.000Z" } }
      : null,
  }));
  mocks.credentials.mockImplementation(async (_provider, excluded) => excluded.has("test-connection")
    ? null : { connectionId: "test-connection", releaseRouteSlot() {} });
  mocks.core.mockResolvedValue({ success: true, response: Response.json({ answer: "sol" }) });
});

const executedModels = () => mocks.core.mock.calls.map(([options]) => options.modelInfo.model);

describe("combo member quota routing", () => {
  it("skips exhausted Astra and executes the nested Sol combo", async () => {
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(executedModels()).toEqual(["gpt-6.1-sol"]);
  });

  it("tries Astra first when its member quota is not exhausted", async () => {
    exhausted.clear();
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(executedModels()).toEqual(["gpt-6-astra"]);
  });

  it("falls back to Sol when the upstream returns HTTP 429", async () => {
    exhausted.clear();
    mocks.core.mockResolvedValueOnce({
      success: false, status: 429, error: "Usage limit reached",
      response: Response.json({ error: { message: "Usage limit reached" } }, { status: 429 }),
    });
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(executedModels()).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  });

  it("continues within Sol after a member's account/model entitlement rejection", async () => {
    graph[1].models.push({ model: "backup/gpt-6.1-sol" });
    const error = '[400]: {"code":11158,"msg":"model [gpt-6.1-sol] is not allowed for user type [personal_free_user]"}';
    mocks.core.mockResolvedValueOnce({
      success: false, status: 400, error,
      response: Response.json({ error: { message: error } }, { status: 400 }),
    });
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(mocks.core.mock.calls.map(([options]) => options.modelInfo.provider)).toEqual(["cx", "backup"]);
    expect(executedModels()).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"]);
  });

  it("propagates an exhausted child entitlement failure to the parent's next member", async () => {
    graph[0].models.push({ model: "backup/last-resort" });
    const error = 'Your account type does not support this model.';
    mocks.core.mockResolvedValueOnce({
      success: false, status: 400, error,
      response: Response.json({ error: { message: error } }, { status: 400 }),
    });
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(executedModels()).toEqual(["gpt-6.1-sol", "last-resort"]);
  });

  it("does not retry other Sol members for a malformed request", async () => {
    graph[1].models.push({ model: "backup/gpt-6.1-sol" });
    mocks.core.mockResolvedValueOnce({
      success: false, status: 400, error: "Unsupported parameter: reasoning_effort",
      response: Response.json({ error: { message: "Unsupported parameter: reasoning_effort" } }, { status: 400 }),
    });
    expect((await handleChat(request())).status).toBe(400);
    expect(executedModels()).toEqual(["gpt-6.1-sol"]);
  });

  it("rejects whole-key quota exhaustion before any member routing", async () => {
    mocks.authorize.mockResolvedValue(Response.json({ error: { code: "api_key_quota_exceeded" } }, { status: 429 }));
    const response = await handleChat(request());
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("api_key_quota_exceeded");
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it("reports failure when Sol's own member quota is also exhausted", async () => {
    exhausted.add("cx/gpt-6.1-sol");
    const response = await handleChat(request());
    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toContain('Every model in "gpt-6.1-sol"');
    expect(mocks.core).not.toHaveBeenCalled();
  });
});
