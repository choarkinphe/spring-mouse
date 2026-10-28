import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, forcedSSEToJsonMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  forcedSSEToJsonMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: forcedSSEToJsonMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

async function runNativeCodexRequest(model, reasoning, maxEffort, translated = false) {
  const body = translated
    ? { model, messages: [{ role: "user", content: "hello" }], stream: false, reasoning_effort: reasoning?.effort }
    : { model, input: "hello", stream: false, ...(reasoning ? { reasoning } : {}) };

  await handleChatCore({
    body,
    modelInfo: { provider: "codex", model },
    maxEffort,
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride: translated ? "openai" : "openai-responses",
    clientRawRequest: {
      endpoint: translated ? "/v1/chat/completions" : "/v1/responses",
      body,
      headers: {
        accept: "application/json",
        "user-agent": translated ? "test-client" : "codex-cli/0.144.1",
      },
    },
  });

  return executeMock.mock.calls.at(-1)[0].body;
}

describe("native Codex passthrough thinking suffixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response("", { status: 200 }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: null,
    });
    forcedSSEToJsonMock.mockResolvedValue({
      success: true,
      response: new Response("{}", { status: 200 }),
    });
  });

  it("caps native reasoning effort while preserving metadata", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-sol", { effort: "high", summary: "detailed" }, "low");

    expect(executeMock).toHaveBeenCalledOnce();
    expect(body.reasoning).toEqual({ effort: "low", summary: "detailed" });
  });

  it("preserves native reasoning effort below the cap", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-sol", { effort: "low" }, "high");

    expect(executeMock).toHaveBeenCalledOnce();
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("does not add native reasoning when it is absent", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-sol", undefined, "low");

    expect(executeMock).toHaveBeenCalledOnce();
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("does not convert a numeric model suffix to effort when the ceiling is none", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-sol(2048)", undefined, "none");

    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning?.effort).toBe("none");
  });

  it("caps Claude adaptive passthrough after normalization", async () => {
    const body = { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hello" }], stream: false, thinking: { type: "adaptive" }, max_tokens: 4096 };
    await handleChatCore({
      body,
      modelInfo: { provider: "claude", model: "claude-haiku-4-5" },
      maxEffort: "low",
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-connection",
      sourceFormatOverride: "claude",
      clientRawRequest: { endpoint: "/v1/messages", body, headers: { "user-agent": "claude-cli/2.0.0", accept: "application/json" } },
    });
    const sent = executeMock.mock.calls.at(-1)[0].body;
    expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("caps effort on a translated chat completions request", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-sol", { effort: "high" }, "low", true);

    expect(executeMock).toHaveBeenCalledOnce();
    expect(body).toHaveProperty("input");
    expect(body).not.toHaveProperty("messages");
    expect(body.reasoning_effort).toBe("low");
  });

  it("forwards Ultra for Sol", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-sol(ultra)");

    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning).toEqual({ effort: "ultra" });
  });

  it("converts unsupported Luna Ultra to Max without dropping reasoning metadata", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-luna(ultra)", {
      effort: "low",
      summary: "detailed",
    });

    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "max", summary: "detailed" });
  });

  it("forwards Ultra through a Terra review alias", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-terra-review(ultra)", {
      effort: "low",
    });

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning).toEqual({ effort: "ultra" });
  });
});
