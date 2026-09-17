// A Mouse-bound account is dispatched over the node's tunnel, so the Spring
// host is not the machine that ran the work. Without the node on the record an
// operator reading a route line, a request-detail row or the console drawer
// cannot tell "which node served this" from "it ran here".
//
// These tests pin the three places the node is recorded — the request detail
// persisted for the drawer, the always-visible ▶ route line, and the node label
// itself — for both the success and the failure paths.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock, saveRequestDetailMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveRequestDetailMock: vi.fn(async () => {}),
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

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: saveRequestDetailMock,
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const MOUSE = { mouseId: "11112222-3333-4444-5555-666677778888", name: "tokyo-edge" };

function chatCoreArgs({ mouseExecution, log } = {}) {
  return {
    body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData: {}, ...(mouseExecution ? { mouseExecution } : {}) },
    log,
    connectionId: "test-conn",
    requestId: "req-mouse-0001",
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" },
    },
  };
}

function routeLineOf(log) {
  const call = log.routeLine.mock.calls[0];
  return call ? call[2] : null;
}

describe("the executed Mouse node is recorded on routed requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("stores the node id and name on the persisted request detail", async () => {
    await handleChatCore(chatCoreArgs({ mouseExecution: MOUSE }));

    expect(saveRequestDetailMock).toHaveBeenCalled();
    const detail = saveRequestDetailMock.mock.calls.at(-1)[0];
    expect(detail.mouse).toEqual({ id: MOUSE.mouseId, name: "tokyo-edge" });
  });

  it("names the node on the always-visible route line", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), routeLine: vi.fn() };

    await handleChatCore(chatCoreArgs({ mouseExecution: MOUSE, log }));

    expect(routeLineOf(log)).toContain("MOUSE:tokyo-edge");
  });

  it("stores the node when the dispatch fails, so a failed attempt still names it", async () => {
    executeMock.mockRejectedValue(new Error("node went away"));

    await handleChatCore(chatCoreArgs({ mouseExecution: MOUSE }));

    const detail = saveRequestDetailMock.mock.calls.at(-1)[0];
    expect(detail.status).toBe("error");
    expect(detail.mouse).toEqual({ id: MOUSE.mouseId, name: "tokyo-edge" });
  });

  it("omits the node entirely for a request that ran on the Spring host", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), routeLine: vi.fn() };

    await handleChatCore(chatCoreArgs({ log }));

    const detail = saveRequestDetailMock.mock.calls.at(-1)[0];
    expect(detail.mouse).toBeUndefined();
    expect(routeLineOf(log)).not.toContain("MOUSE:");
  });
});
