import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn(), refreshed: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: false, execute: mocks.execute, refreshCredentials: mocks.refresh }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn() }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
const payload = { code: 11140, msg: "request illegal", retry_policy: { retry: false } };
function result(status, body) {
  return { response: Response.json(body, { status }), url: "https://upstream.invalid", headers: {}, transformedBody: {} };
}
function run(provider = "workbuddy", credentials = {}) {
  return handleChatCore({
    body: { model: "test-model", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider, model: "test-model" }, credentials: { accessToken: "synthetic", refreshToken: "synthetic-rt", ...credentials },
    sourceFormatOverride: "openai", internalRequest: true, observabilityEnabled: false, onCredentialsRefreshed: mocks.refreshed,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue({ accessToken: "renewed" });
});
describe("WorkBuddy account restriction before auth recovery", () => {
  it.each(["workbuddy", "workbuddy-ai", "codebuddy-cn", "codebuddy-intl"])("never refreshes or resends restricted %s", async provider => {
    mocks.execute.mockResolvedValue(result(403, payload));
    const response = await run(provider);
    expect(response.status).toBe(403);
    expect(response.upstreamError.body).toBe(JSON.stringify(payload));
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.refreshed).not.toHaveBeenCalled();
  });
  it("preserves a restriction returned after a legitimate 401 refresh", async () => {
    mocks.execute.mockResolvedValueOnce(result(401, { error: "expired" })).mockResolvedValueOnce(result(403, payload));
    const response = await run();
    expect(response.status).toBe(403);
    expect(response.upstreamError.body).toBe(JSON.stringify(payload));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
  it("does not refresh or execute a persisted restricted credential", async () => {
    const response = await run("workbuddy", { accountRestriction: { code: 11140 } });
    expect(response.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("retains ordinary 403 refresh behavior without matching text mentions", async () => {
    mocks.execute.mockResolvedValue(result(403, { code: 999, msg: "not code 11140" }));
    await run();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
});
