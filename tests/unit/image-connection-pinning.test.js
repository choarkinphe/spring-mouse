import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ credentials: vi.fn(), core: vi.fn(), mark: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.mark, authorizeModelAccess: vi.fn(), clearAccountError: vi.fn(), extractApiKey: () => null, authorizeApiKey: async () => null, resolveApiKeyAccessTags: async () => [] }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}), getComboByName: vi.fn() }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: async () => ({ provider: "codex", model: "actual-model-image" }), getComboModels: async () => null }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.core }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_provider, creds) => creds, updateProviderCredentials: vi.fn() }));
vi.mock("@/sse/services/ingressUsage.js", () => ({ recordIngressUsage: vi.fn() }));
const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");
const request = (pinned = true) => new Request("http://localhost/v1/images/generations", { method: "POST", headers: pinned ? { "x-connection-id": "a" } : {}, body: JSON.stringify({ model: "cx/actual-model-image", prompt: "test" }) });
beforeEach(() => { vi.clearAllMocks(); });
describe("image generation connection pinning", () => {
  it("uses strict selection and never runs upstream for unavailable account", async () => {
    mocks.credentials.mockResolvedValue({ pinnedUnavailable: true, error: "selected account unavailable" });
    expect((await handleImageGeneration(request())).status).toBe(503);
    expect(mocks.credentials).toHaveBeenCalledWith("codex", expect.any(Set), "actual-model-image", expect.objectContaining({ strictConnectionId: "a" }));
    expect(mocks.core).not.toHaveBeenCalled();
  });
  it("does not fall back to another account after a pinned upstream failure", async () => {
    mocks.credentials.mockResolvedValue({ connectionId: "a" });
    mocks.core.mockResolvedValue({ success: false, status: 429, error: "limited", response: Response.json({ error: "limited" }, { status: 429 }) });
    mocks.mark.mockResolvedValue({ shouldFallback: true });
    expect((await handleImageGeneration(request())).status).toBe(429);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
  });
  it("passes client cancellation through to the image core", async () => {
    mocks.credentials.mockResolvedValue({ connectionId: "a" });
    mocks.core.mockResolvedValue({ success: true, response: Response.json({ data: [{ b64_json: "ok" }] }) });
    const req = request();
    await handleImageGeneration(req);
    expect(mocks.core).toHaveBeenCalledWith(expect.objectContaining({ signal: req.signal }));
  });
  it("preserves normal fallback when no explicit account was selected", async () => {
    mocks.credentials.mockResolvedValueOnce({ connectionId: "a" }).mockResolvedValueOnce({ connectionId: "b" });
    mocks.core.mockResolvedValueOnce({ success: false, status: 429, error: "limited" }).mockResolvedValueOnce({ success: true, response: Response.json({ data: [{ b64_json: "ok" }] }) });
    mocks.mark.mockResolvedValue({ shouldFallback: true });
    expect((await handleImageGeneration(request(false))).status).toBe(200);
    expect(mocks.credentials).toHaveBeenCalledTimes(2);
  });
});
