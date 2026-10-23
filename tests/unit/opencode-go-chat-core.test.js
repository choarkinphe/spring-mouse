import { describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: false, execute }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const ENDPOINT = "https://opencode.ai/inference/go/openai/v1/chat/completions";

describe("OpenCode Go chatCore transport and identity", () => {
  it.each(["deepseek-v4.1-flash", "future-go-model"])("translates Claude input to chat for %s and retains original session metadata", async model => {
    execute.mockReset();
    execute.mockImplementation(async args => ({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: ENDPOINT,
      headers: {},
      transformedBody: args.body,
    }));
    const credentials = {
      apiKey: "test-key",
      // A reused credentials object must not retain a preceding Messages route.
      runtimeTransport: { format: "claude", baseUrl: "https://invalid.test/messages" },
    };
    await handleChatCore({
      body: {
        model, stream: false, max_tokens: 16,
        metadata: { user_id: JSON.stringify({ session_id: "stable-conversation", account_id: "private-account" }) },
        messages: [{ role: "user", content: "hello" }],
      },
      sourceFormatOverride: "claude",
      modelInfo: { provider: "opencode-go", model },
      credentials,
      internalRequest: true,
      observabilityEnabled: false,
      clientRawRequest: { headers: { "user-agent": "MyAgent/1" }, endpoint: "/v1/messages" },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(credentials.runtimeTransport).toBeNull();
    const executor = new DefaultExecutor("opencode-go");
    expect(executor.buildUrl(model, false, 0, credentials)).toBe(ENDPOINT);
    const headers = executor.buildHeaders(credentials, false);
    expect(headers["x-opencode-session"]).toMatch(/^sm_[a-f0-9]{64}$/);
    expect(headers["User-Agent"]).toBe("MyAgent/1");
    expect(JSON.stringify(headers)).not.toContain("private-account");
  });
});
