import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(), markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  extractApiKey: vi.fn(), authorizeApiKey: vi.fn(), resolveApiKeyAccessTags: vi.fn(),
  getModelInfo: vi.fn(), saveRequestUsage: vi.fn(), handleSystemoneCore: vi.fn(), getSettings: vi.fn(),
}));
vi.mock("../../src/sse/services/auth.js", () => mocks);
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("@/lib/db/index.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("../../open-sse/handlers/systemoneCore.js", async (importOriginal) => ({ ...await importOriginal(), handleSystemoneCore: mocks.handleSystemoneCore }));
import { handleSystemone } from "../../src/sse/handlers/systemone.js";
const body = { model: "jev-latest", state: "hello", questions: { urgent: { type: "noul", instructions: "Is it urgent?" } } };
const request = (value = body) => new Request("http://localhost/v1/systemone", { method: "POST", body: JSON.stringify(value) });
const failure = (status, extra = {}) => ({ success: false, status, error: "fixture error", response: Response.json({ detail: "fixture error" }, { status }), ...extra });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: true });
  mocks.getProviderCredentials.mockResolvedValue({ apiKey: "provider-secret", connectionId: "a" });
  mocks.extractApiKey.mockReturnValue("client-key");
  mocks.authorizeApiKey.mockResolvedValue(null);
  mocks.resolveApiKeyAccessTags.mockResolvedValue(["team-a"]);
  mocks.getModelInfo.mockResolvedValue({ provider: "jevapi", model: "jev-latest" });
  mocks.saveRequestUsage.mockResolvedValue(undefined);
  mocks.handleSystemoneCore.mockResolvedValue({ success: true, usage: { input_tokens: 18, output_tokens: 4 }, response: Response.json({ model: "jev-1.13.0", answers: {} }) });
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});
describe("System One gateway authorization and accounting", () => {
  it("canonicalizes native model ids and meters the gateway key while using stored credentials", async () => {
    expect((await handleSystemone(request())).status).toBe(200);
    expect(mocks.getModelInfo).toHaveBeenCalledWith("jevapi/jev-latest");
    expect(mocks.authorizeApiKey).toHaveBeenCalledWith("client-key", expect.objectContaining({ requireApiKey: true, meter: true, model: "jevapi/jev-latest" }));
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("jevapi", expect.any(Set), "jev-latest", { accessTags: ["team-a"], requesterId: "client-key" });
    expect(mocks.handleSystemoneCore).toHaveBeenCalledWith(expect.objectContaining({ credentials: { apiKey: "provider-secret", connectionId: "a" } }));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "jevapi", model: "jev-latest", apiKey: "client-key", status: "success", tokens: { prompt_tokens: 18, completion_tokens: 4, total_tokens: 22 } }));
  });
  it.each([null, {}, { input_tokens: "18", output_tokens: 4 }, { input_tokens: -1, output_tokens: 4 }, { input_tokens: 18, output_tokens: 4, estimated: true }])("does not invent exact usage for invalid counters %#", async (usage) => {
    mocks.handleSystemoneCore.mockResolvedValue({ success: true, usage, response: Response.json({}) });
    expect((await handleSystemone(request())).status).toBe(200);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ tokens: { prompt_tokens: 0, completion_tokens: 0 } }));
  });
  it("stops unauthorized calls before credentials or upstream", async () => {
    mocks.authorizeApiKey.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
    expect((await handleSystemone(request())).status).toBe(401);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });
  it.each([[], ["other-team"]])("rejects a valid key without an allowed interface tag %#", async (tags) => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false, systemoneAccessTags: ["jev-users"] });
    mocks.resolveApiKeyAccessTags.mockResolvedValue(tags);
    expect((await handleSystemone(request())).status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
  it("allows any matching tag after normalization", async () => {
    mocks.getSettings.mockResolvedValue({ systemoneAccessTags: ["team-b", " TEAM-A "] });
    expect((await handleSystemone(request())).status).toBe(200);
    expect(mocks.handleSystemoneCore).toHaveBeenCalledOnce();
  });
  it("requires authentication even in local mode when interface tags are set", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false, systemoneAccessTags: ["team-a"] });
    mocks.extractApiKey.mockReturnValue(null);
    mocks.authorizeApiKey.mockImplementation(async (_key, options) => options.requireApiKey ? Response.json({ error: "Missing API key" }, { status: 401 }) : null);
    expect((await handleSystemone(request())).status).toBe(401);
    expect(mocks.authorizeApiKey).toHaveBeenCalledWith(null, expect.objectContaining({ requireApiKey: true }));
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
  it("preserves unconfigured interface behavior", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false, systemoneAccessTags: [] });
    mocks.resolveApiKeyAccessTags.mockResolvedValue([]);
    expect((await handleSystemone(request())).status).toBe(200);
  });
  it.each(["jev-latest", "jevapi/jev-latest", "custom-alias"])("cannot bypass interface tags with model spelling %s", async (model) => {
    mocks.getSettings.mockResolvedValue({ systemoneAccessTags: ["jev-users"] });
    expect((await handleSystemone(request({ ...body, model, accessTags: ["jev-users"] }))).status).toBe(403);
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });
  it("enforces model access tags after interface access passes", async () => {
    mocks.getProviderCredentials.mockResolvedValue({ accessDenied: true });
    expect((await handleSystemone(request())).status).toBe(403);
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });
  it.each([null, [], { ...body, state: false }])("rejects malformed bodies safely %#", async (value) => {
    expect((await handleSystemone(request(value))).status).toBe(400);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
  it("rejects other providers", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-test" });
    expect((await handleSystemone(request({ ...body, model: "openai/gpt-test" }))).status).toBe(400);
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });
  it("rotates once per failed account with upstream cooldown evidence", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ apiKey: "bad-key", connectionId: "a" }).mockResolvedValueOnce({ apiKey: "good-key", connectionId: "b" });
    const upstreamError = { source: "http", retryAfterMs: 30000 };
    mocks.handleSystemoneCore.mockResolvedValueOnce(failure(429, { upstreamError }));
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    expect((await handleSystemone(request())).status).toBe(200);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("a", 429, "fixture error", "jevapi", "jev-latest", undefined, upstreamError);
    expect(mocks.getProviderCredentials.mock.calls[1][1].has("a")).toBe(true);
    expect(mocks.clearAccountError).toHaveBeenCalledWith("b", expect.any(Object), "jev-latest");
  });
  it("returns the final native error after accounts are exhausted", async () => {
    mocks.handleSystemoneCore.mockResolvedValue(failure(529));
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.getProviderCredentials.mockResolvedValueOnce({ apiKey: "bad-key", connectionId: "a" }).mockResolvedValueOnce(null);
    const response = await handleSystemone(request());
    expect(response.status).toBe(529);
    expect(await response.json()).toEqual({ detail: "fixture error" });
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });
  it("does not retry native validation errors", async () => {
    mocks.handleSystemoneCore.mockResolvedValue(failure(422));
    expect((await handleSystemone(request())).status).toBe(422);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });
  it("does not use credentials when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await handleSystemone(new Request("http://localhost/v1/systemone", { method: "POST", body: JSON.stringify(body), signal: controller.signal }))).status).toBe(499);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});
