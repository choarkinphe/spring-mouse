/**
 * Guards the streamController hooks chatCore installs to settle a streaming
 * attempt when the stream pipeline never reaches its own settle.
 *
 * Why this exists: chat.js no longer settles a streaming attempt from the lazy
 * success result (see streaming-attempt-settlement.test.js), so the ONLY thing
 * that settles such an attempt is the stream pipeline. But the pipeline does not
 * settle every termination — a client disconnect, or an upstream socket that dies
 * mid-stream, leaves it unsettled, and the attempt row would sit at
 * outcome=unknown forever. chatCore therefore settles it from the
 * streamController's disconnect/error hooks, and this file pins that wiring
 * against the REAL handleChatCore (createStreamController is mocked so the hooks
 * can be invoked directly).
 *
 * The risk this covers is concrete: if someone deletes those hook bodies — they
 * look like pure telemetry plumbing — a whole class of streaming attempts silently
 * stops being recorded, with no test failure anywhere else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, streamControllerMock, capturedOptions } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  streamControllerMock: { signal: undefined, handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn() },
  capturedOptions: { current: null },
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock, refreshCredentials: vi.fn().mockResolvedValue(null) })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({ logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn((options) => {
    // Capture the hooks chatCore installs so the test can fire them.
    capturedOptions.current = options;
    return streamControllerMock;
  }),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/translator/formats/claude.js", () => ({ normalizeClaudePassthrough: vi.fn() }));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({ compressWithHeadroom: vi.fn(async () => null), formatHeadroomLog: vi.fn(() => ""), formatHeadroomSizeLog: vi.fn(() => ""), isHeadroomPhantomSavings: vi.fn(() => false) }));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({ compressWithPxpipe: vi.fn(async () => null) }));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));
vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
  HTTP_STATUS: { BAD_GATEWAY: 502, GATEWAY_TIMEOUT: 504, SERVICE_UNAVAILABLE: 503 },
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

const { createRoutingTelemetrySession } = await import("../../src/sse/services/routingTelemetry.js");
const { createRoutingObserver } = await import("../../open-sse/utils/routingOutcome.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function optionsWith(observer) {
  const body = { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }], stream: true };
  return {
    body,
    modelInfo: { provider: "openai", model: "gpt-4.1" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "text/event-stream" } },
    connectionId: "test-connection",
    routingObserver: observer,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), errorLine: vi.fn(), tagForSession: vi.fn(() => ""), nextTag: vi.fn(() => "") },
  };
}

function wired() {
  const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
  const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "openai", model: "gpt-4.1", connectionId: "test-connection" });
  const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });
  return { session, attempt, observer };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedOptions.current = null;
  executeMock.mockReset();
  // The executor rejects, so handleChatCore installs the hooks and then returns a
  // failure result without ever producing a streaming body. That is enough to
  // reach the hooks under test.
  executeMock.mockRejectedValue(new Error("upstream unavailable"));
});

describe("chatCore streaming attempt fallback settlement", () => {
  it("installs a disconnect hook that settles the attempt as cancelled", async () => {
    const { attempt, observer } = wired();
    await handleChatCore(optionsWith(observer));

    expect(capturedOptions.current).toBeTruthy();
    expect(typeof capturedOptions.current.onDisconnect).toBe("function");

    expect(attempt.isSettled()).toBe(false);
    capturedOptions.current.onDisconnect({ reason: "client_closed", duration: 5 });

    expect(attempt.isSettled()).toBe(true);
    expect(attempt.terminal?.outcome).toBe("cancelled");
    expect(attempt.terminal?.terminalReason).toBe("client_abort");
  });

  it("installs an error hook that settles the attempt as failed", async () => {
    const { attempt, observer } = wired();
    await handleChatCore(optionsWith(observer));

    expect(typeof capturedOptions.current.onError).toBe("function");
    capturedOptions.current.onError(new Error("stream stall timeout"));

    expect(attempt.isSettled()).toBe(true);
    expect(attempt.terminal?.outcome).toBe("failed");
    expect(attempt.terminal?.terminalReason).toBe("stream_error");
  });

  it("does not relabel a recorded protocol terminal when the client then disconnects", async () => {
    const { attempt, observer } = wired();
    await handleChatCore(optionsWith(observer));

    // The stream finished successfully first...
    observer.recordTerminal({ outcome: "valid_terminal", terminalReason: "terminal" });
    observer.settle({ upstreamStatus: 200 });
    // ...and only afterwards does the client disconnect.
    capturedOptions.current.onDisconnect({ reason: "client_closed", duration: 5 });

    expect(attempt.terminal?.outcome).toBe("valid_terminal");
    expect(attempt.terminal?.terminalReason).toBe("terminal");
  });

  it("is fail-open when the observer is null", async () => {
    // open-sse consumers and tests may call handleChatCore without an observer.
    await expect(handleChatCore(optionsWith(null))).resolves.toBeDefined();
    capturedOptions.current.onDisconnect({ reason: "client_closed", duration: 5 });
    capturedOptions.current.onError(new Error("boom"));
  });
});
