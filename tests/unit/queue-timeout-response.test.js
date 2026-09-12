// End-to-end guard for the concurrency-rejection HTTP contract.
//
// Before the fix, chat.js answered every queue timeout with `Retry-After: 1`
// and the literal text "retry after 1s", even when the request had waited out
// the entire 60s queue window. Clients dutifully retried a second later, queued
// for another full window and failed again — a retry storm amplifying an
// already saturated gate.
//
// This drives the real handler down its queue-timeout branch and asserts what a
// client actually receives. Only the routing/auth boundary is stubbed; the
// error formatting (`open-sse/utils/error.js`) is the production code.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutingQueueTimeoutError } from "../../src/lib/redis/connectionSlots.js";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  extractApiKey: vi.fn(() => "router-key"),
  authorizeApiKey: vi.fn(async () => null),
  resolveApiKeyAccessTags: vi.fn(async () => []),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getComboByName: vi.fn(async () => null),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(async () => null),
  handleBypassRequest: vi.fn(() => null),
  refreshModelCapabilityOverrides: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  warn: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  extractApiKey: mocks.extractApiKey,
  authorizeApiKey: mocks.authorizeApiKey,
  resolveApiKeyAccessTags: mocks.resolveApiKeyAccessTags,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), error: vi.fn(),
  warn: mocks.warn,
  routeLine: vi.fn(), errorLine: vi.fn(),
  tagForSession: vi.fn(() => "🟢"),
  maskKey: vi.fn((key) => `masked:${key}`),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getComboByName: mocks.getComboByName,
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.handleBypassRequest }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => []),
  getComboModelsForRequest: vi.fn(() => []),
  getUnsupportedComboRequestCapability: vi.fn(() => null),
}));
vi.mock("@/lib/modelCapabilityOverrides", () => ({
  refreshModelCapabilityOverrides: mocks.refreshModelCapabilityOverrides,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("@/lib/networkTraffic.js", () => ({ getTrafficRequestId: vi.fn(() => null) }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

function makeRequest(body = { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }) {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer router-key" },
    body: JSON.stringify(body),
  });
}

describe("queue timeout response contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelInfo.mockResolvedValue({ provider: "deepseek", model: "deepseek-v4-flash" });
  });

  it("advertises the real backoff window instead of a hardcoded 1s", async () => {
    mocks.getProviderCredentials.mockRejectedValue(new RoutingQueueTimeoutError("deepseek", 60_000));

    const response = await handleChat(makeRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Retry-After")).not.toBe("1");

    const body = await response.json();
    expect(body.error.message).toContain("concurrency limit");
    expect(body.error.message).toContain("retry after 60s");
    expect(body.error.message).not.toContain("retry after 1s");
  });

  it("logs the real wait so operators can tell queue pressure from a lock", async () => {
    mocks.getProviderCredentials.mockRejectedValue(new RoutingQueueTimeoutError("deepseek", 60_000));

    await handleChat(makeRequest());

    const line = mocks.warn.mock.calls.map((call) => call.join(" ")).find((text) => text.includes("queue timeout"));
    expect(line).toContain("queue timeout after 60000ms");
    expect(line).toContain("retry after 60s");
  });

  it("keeps a short configured window honest in both the hint and the log", async () => {
    mocks.getProviderCredentials.mockRejectedValue(new RoutingQueueTimeoutError("codex", 1_000));

    const response = await handleChat(makeRequest());

    // 1s of waiting is below the floor, so the hint is raised to 5s...
    expect(response.headers.get("Retry-After")).toBe("5");
    // ...but the log still reports exactly how long the request waited.
    const line = mocks.warn.mock.calls.map((call) => call.join(" ")).find((text) => text.includes("queue timeout"));
    expect(line).toContain("queue timeout after 1000ms");
  });

  it("lets an explicit retry hint override the derived one", async () => {
    mocks.getProviderCredentials.mockRejectedValue(new RoutingQueueTimeoutError("codex", 60_000, 12_000));

    const response = await handleChat(makeRequest());

    expect(response.headers.get("Retry-After")).toBe("12");
    expect((await response.json()).error.message).toContain("retry after 12s");
  });

  it("persists a rejected row so rejections are countable", async () => {
    mocks.getProviderCredentials.mockRejectedValue(new RoutingQueueTimeoutError("deepseek", 60_000));

    await handleChat(makeRequest());

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    // "rejected" sits outside the ["success","ok"] set usageRepo counts towards
    // API-key quota, so audit rows can never silently consume quota.
    expect(entry.status).toBe("rejected");
    expect(entry.provider).toBe("deepseek");
    expect(entry.model).toBe("deepseek-v4-flash");
    expect(entry.endpoint).toBe("/v1/chat/completions");
    expect(entry.startedAt).toBeTruthy();
    expect(entry.completedAt).toBeTruthy();
  });

  it("records rejections from the no-enabled-account branch too", async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);

    const response = await handleChat(makeRequest());

    expect(response.status).toBe(404);
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage.mock.calls[0][0].status).toBe("rejected");
  });
});
