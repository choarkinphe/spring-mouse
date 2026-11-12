import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ aliases: {}, combo: null, connections: [], settings: {}, disabled: {}, tags: [], denied: false, authFailure: null, core: vi.fn(), credentials: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => mocks.aliases,
  getComboByName: async () => mocks.combo,
  getProviderNodes: async () => [],
  getProviderConnections: async () => mocks.connections,
  getSettings: async () => mocks.settings,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => mocks.disabled }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  authorizeModelAccess: async () => mocks.denied ? { accessDenied: true } : null,
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(), extractApiKey: () => "fixture-key",
  authorizeApiKey: async () => mocks.authFailure, resolveApiKeyAccessTags: async () => mocks.tags,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_provider, creds) => creds, updateProviderCredentials: vi.fn() }));
vi.mock("@/sse/services/ingressUsage.js", () => ({ recordIngressUsage: vi.fn() }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.core }));
const { getModelInfo, getImageModelInfo } = await import("@/sse/services/model.js");
const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");
const native = "gpt-image-2";
const request = (model = native) => new Request("http://localhost/v1/images/generations", { method: "POST", body: JSON.stringify({ model, prompt: "test", size: "auto", quality: "auto", background: "auto" }) });
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks, { aliases: {}, combo: null, connections: [{ provider: "codex", isActive: true }], settings: {}, disabled: {}, tags: [], denied: false, authFailure: null });
  mocks.credentials.mockResolvedValue({ connectionId: "fixture" });
  mocks.core.mockImplementation(async () => ({ success: true, response: Response.json({ created: 123, data: [{ b64_json: "fixture" }] }) }));
});
describe("native Codex image client routing", () => {
  it("resolves the fixed native ID only in image context", async () => {
    expect(await getImageModelInfo(native)).toEqual({ provider: "codex", model: native });
    expect(await getModelInfo(native)).toEqual({ provider: "openai", model: native });
    expect(await getImageModelInfo("gpt-image-1")).toEqual({ provider: "openai", model: "gpt-image-1" });
  });
  it.each([{ connections: [] }, { connections: [{ provider: "codex", isActive: false }] }, { connections: [{ provider: "openai", isActive: true }] }])("retains OpenAI inference without an enabled Codex connection: %j", async ({ connections }) => {
    mocks.connections = connections;
    expect(await getImageModelInfo(native)).toEqual({ provider: "openai", model: native });
  });
  it.each(["openai/gpt-image-2", "cx/gpt-image-2", "codex/gpt-image-2"])("preserves explicit provider route %s", async (id) => {
    expect(await getImageModelInfo(id)).toEqual({ provider: id.startsWith("openai/") ? "openai" : "codex", model: native });
  });
  it.each(["openai/gpt-image-2", "other/custom-image"])("preserves explicit alias to %s", async (target) => {
    mocks.aliases = { [native]: target };
    expect(await getImageModelInfo(native)).toMatchObject({ provider: target.split("/")[0], routeKind: "alias" });
  });
  it("does not replace an operator combo", async () => {
    mocks.combo = { name: native, isActive: true, models: ["cx/gpt-image-2"] };
    expect(await getImageModelInfo(native)).toMatchObject({ provider: null, routeKind: "combo" });
    expect((await handleImageGeneration(request())).status).toBe(200);
  });
  it.each([native, "cx/gpt-image-2", "codex/gpt-image-2"])("accepts client image request %s without changing the upstream protocol ID", async (id) => {
    expect((await handleImageGeneration(request(id))).status).toBe(200);
    expect(mocks.core).toHaveBeenCalledWith(expect.objectContaining({ modelInfo: { provider: "codex", model: native }, body: expect.objectContaining({ size: "auto", quality: "auto", background: "auto" }) }));
  });
  it.each(["cx", "codex"])("blocks disabled native models under %s for both client IDs", async (alias) => {
    mocks.disabled = { [alias]: [native] };
    for (const id of [native, "cx/gpt-image-2"]) expect((await handleImageGeneration(request(id))).status).toBe(403);
    expect(mocks.core).not.toHaveBeenCalled(); expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it("does not bypass model tags, account authorization, or gateway authentication", async () => {
    mocks.denied = true;
    expect((await handleImageGeneration(request())).status).toBe(403);
    mocks.denied = false; mocks.credentials.mockResolvedValue({ accessDenied: true });
    expect((await handleImageGeneration(request())).status).toBe(403);
    mocks.authFailure = Response.json({ error: "Unauthorized" }, { status: 401 });
    expect((await handleImageGeneration(request())).status).toBe(401);
    expect(mocks.core).not.toHaveBeenCalled();
  });
  it("enforces combo-only policy on both direct names, but allows configured image combos", async () => {
    mocks.settings = { comboOnlyRouting: { enabled: true } };
    for (const id of [native, "cx/gpt-image-2"]) expect((await handleImageGeneration(request(id))).status).toBe(403);
    expect(mocks.core).not.toHaveBeenCalled();
    mocks.combo = { name: native, kind: "image", models: ["cx/gpt-image-2"] };
    expect((await handleImageGeneration(request())).status).toBe(200);
    mocks.combo = null; mocks.tags = ["god"];
    expect((await handleImageGeneration(request())).status).toBe(200);
  });
});
