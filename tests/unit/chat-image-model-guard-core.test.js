import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_NATIVE_IMAGE_MODEL } from "open-sse/config/codexImage.js";

const mocks = vi.hoisted(() => ({ getExecutor: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: mocks.getExecutor }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(), saveRequestUsage: vi.fn(),
}));
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { getChatModelError } from "open-sse/shared/chatModel.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected upstream request"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("image model chat guard core", () => {
  it.each(["openai", "openai-responses", "claude"])("rejects native Codex images before transport selection (%s)", async (sourceFormatOverride) => {
    const result = await handleChatCore({
      body: { model: CODEX_NATIVE_IMAGE_MODEL, stream: true },
      modelInfo: { provider: "codex", model: CODEX_NATIVE_IMAGE_MODEL },
      sourceFormatOverride,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.upstreamError).toBeNull();
    expect((await result.response.json()).error).toMatchObject({
      type: "invalid_request_error", message: expect.stringContaining("POST /v1/images/generations"),
    });
    expect(mocks.getExecutor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", "gpt-6-astra"],
    ["codex", "gpt-5.5-image"],
    ["antigravity", "gemini-image"],
    ["custom", CODEX_NATIVE_IMAGE_MODEL],
  ])("does not broaden the guard to unrelated models: %s/%s", (provider, model) => {
    expect(getChatModelError(provider, model)).toBeNull();
  });
});
