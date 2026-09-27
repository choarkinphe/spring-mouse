/**
 * Regression guard: a STREAMING attempt is settled by the stream pipeline with
 * the real ttft/duration/token numbers, never by the lazy success result.
 *
 * handleStreamingResponse returns `{ success: true, streaming: true, response }`
 * where `response` is a LAZY ReadableStream: at that moment not one upstream byte
 * has been read, so the attempt's ttftMs/durationMs/usage do not exist yet.
 * chat.js used to call attempt.complete(attemptTerminalFromResult(result)) on that
 * result. The session's complete() is first-wins, so it latched durationMs=0 /
 * ttftMs=0 / null tokens and DISCARDED the real values stream.js computes moments
 * later in its settleObserver. Production showed it: 165/165 stream attempts at
 * durationMs=0 while completedAt-startedAt ranged 1.6s-79.7s, so the routing
 * report's p50/p95 latency read 0.
 *
 * NOTE: the authoritative reproducer lives in chat-routing-telemetry.test.js —
 * it drives the real chat.js and asserts the attempt is NOT settled from the
 * lazy result. This file drives the real streaming handler + stream pipeline
 * directly, which pins the CONTRACT of the numbers themselves. It does not mock
 * the pipeline, because the previous telemetry bug was invisible precisely
 * because a test mocked the boundary that was wrong.
 */
import { describe, expect, it } from "vitest";

import { createRoutingTelemetrySession } from "@/sse/services/routingTelemetry.js";
import { createRoutingObserver } from "open-sse/utils/routingOutcome.js";
import { createStreamController } from "open-sse/utils/streamHandler.js";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";

const silentLog = { warn() {}, info() {}, debug() {}, error() {}, line() {}, errorLine() {} };

function sseResponse(text, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(text)); c.close(); },
  }), { status, headers: { "Content-Type": "text/event-stream" } });
}

/** An OpenAI-format SSE body with content, usage and a terminal finish. */
const OPENAI_SSE = [
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
  "data: [DONE]",
  "",
].join("\n\n");

function stubStreamController() {
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => true,
    handleComplete() {},
    handleError() {},
    handleDisconnect() {},
  };
}

/** Drive the real streaming handler exactly as chatCore does. */
async function driveStreaming({ observer, requestStartTime, sourceFormat = "openai", targetFormat = "openai", body = OPENAI_SSE }) {
  return handleStreamingResponse({
    providerResponse: sseResponse(body),
    provider: "probe", model: "model-x", originalModel: "model-x",
    executedModel: "probe/model-x", routing: {}, routingObserver: observer,
    sourceFormat, targetFormat, userAgent: "test",
    body: {}, stream: true, translatedBody: {}, finalBody: {},
    requestStartTime, requestId: "req-1", trafficRequestId: "traffic-1",
    startedAt: new Date().toISOString(), connectionId: "conn-1", mouse: null,
    apiKey: null, clientRawRequest: { headers: {} }, onRequestSuccess: null,
    reqLogger: { close() {} }, toolNameMap: null, customToolNames: null,
    streamController: stubStreamController(), onStreamComplete: null,
    streamDetailId: null, pxpipe: null, reqTag: null, log: silentLog,
    observabilityEnabled: false, observabilityMaxJsonChars: 0, recordUsage: false,
  });
}

describe("streaming attempt settlement", () => {
  it("marks the streaming result so the caller cannot settle it early", async () => {
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });

    const out = await driveStreaming({ observer, requestStartTime: Date.now() });

    // chat.js keys off this to defer settlement to the stream.
    expect(out.streaming).toBe(true);
    expect(out.success).toBe(true);
  });

  it("records the real durationMs and ttftMs when the stream terminates", async () => {
    const requestStartTime = Date.now() - 250; // a request that started 250ms ago
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime });

    const out = await driveStreaming({ observer, requestStartTime });
    await out.response.text(); // drain the stream so its flush/settle runs

    const terminal = attempt.terminal;
    expect(terminal).toBeTruthy();
    expect(terminal.outcome).toBe("valid_terminal");
    // THE REGRESSION: these were latched at 0 by the early complete().
    expect(terminal.durationMs).toBeGreaterThanOrEqual(250);
    expect(terminal.ttftMs).toBeGreaterThanOrEqual(0);
    expect(terminal.ttftMs).not.toBeNull();
  });

  it("records the upstream token counts the report reads", async () => {
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });

    const out = await driveStreaming({ observer, requestStartTime: Date.now() });
    await out.response.text();

    expect(attempt.terminal?.promptTokens).toBe(11);
    expect(attempt.terminal?.completionTokens).toBe(7);
  });

  it("keeps the upstream status recorded from headers when the terminal settle carries null", async () => {
    // stream.js settles with `upstreamStatus: null` — the HTTP status is not in
    // scope at flush — while emitHeaders() already recorded the real status into
    // attempt.header. A plain `{...header, ...record}` let that null ERASE the
    // status, so every streamed attempt recorded a null upstreamStatus (observed
    // in production: 17/17 post-deploy rows null, 372/372 pre-deploy rows 200).
    // Null means "unknown", never "clear".
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });

    // Headers arrive first and carry the real status...
    observer.emitHeaders({ status: 201, sourceFormat: "openai", targetFormat: "openai", streamMode: "stream" });
    // ...then the stream terminates with the null status it cannot know.
    observer.recordTerminal({ outcome: "valid_terminal", terminalReason: "terminal" });
    observer.settle({ upstreamStatus: null, usage: { prompt_tokens: 3, completion_tokens: 4 } });

    expect(attempt.terminal?.upstreamStatus).toBe(201);
    // The rest of the terminal snapshot still lands.
    expect(attempt.terminal?.promptTokens).toBe(3);
    expect(attempt.terminal?.completionTokens).toBe(4);
  });

  it("does not settle the attempt until the stream has actually been read", async () => {
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });

    const out = await driveStreaming({ observer, requestStartTime: Date.now() });

    // Returning the lazy response must NOT have settled the attempt — that is the
    // whole bug: an unread stream has no measurements to record.
    expect(attempt.isSettled()).toBe(false);
    expect(attempt.terminal).toBeNull();

    await out.response.text();

    expect(attempt.isSettled()).toBe(true);
    expect(attempt.terminal).toBeTruthy();
  });
});

describe("streaming attempt is never left unknown", () => {
  // Once chat.js stops settling the attempt from the lazy result, the ONLY thing
  // that settles a streaming attempt is the stream pipeline. A stream that never
  // reaches its own settle — the client disconnects mid-flight — would leave the
  // attempt row at outcome=unknown forever. chatCore therefore settles it from the
  // streamController's disconnect/error hooks. These tests drive the REAL
  // createStreamController, because a stub would not exercise that wiring.
  it("settles as cancelled when the client disconnects mid-stream", async () => {
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });

    let disconnectReason = null;
    const streamController = createStreamController({
      onDisconnect: ({ reason }) => {
        // Exactly what chatCore's onDisconnect does.
        observer.settleCancelled({ terminalReason: "client_abort" });
        disconnectReason = reason;
      },
      log: silentLog, provider: "probe", model: "model-x",
    });

    expect(attempt.isSettled()).toBe(false);

    streamController.handleDisconnect("client_closed");

    expect(disconnectReason).toBe("client_closed");
    expect(attempt.isSettled()).toBe(true);
    expect(attempt.terminal?.outcome).toBe("cancelled");
    expect(attempt.terminal?.terminalReason).toBe("client_abort");
  });

  it("settles as failed when the upstream stream errors", async () => {
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });

    const streamController = createStreamController({
      onError: (error) => {
        // Exactly what chatCore's onError does.
        if (error?.name === "AbortError") observer.settleCancelled({ terminalReason: "client_abort" });
        else observer.settleFailed({ terminalReason: "stream_error" });
      },
      log: silentLog, provider: "probe", model: "model-x",
    });

    streamController.handleError(new Error("upstream socket died mid-stream"));

    expect(attempt.isSettled()).toBe(true);
    expect(attempt.terminal?.outcome).toBe("failed");
    expect(attempt.terminal?.terminalReason).toBe("stream_error");
  });

  it("does not overwrite a real protocol terminal when the client then disconnects", async () => {
    // The wrapper's settle is once-only and prefers a recorded terminal, so a
    // disconnect AFTER the stream finished must not relabel a success.
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const attempt = session.openAttempt({ modelCallId: "mc", role: "primary", provider: "probe", model: "model-x", connectionId: "conn-1" });
    const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime: Date.now() });

    observer.recordTerminal({ outcome: "valid_terminal", terminalReason: "terminal" });
    observer.settle({ upstreamStatus: 200 });
    observer.settleCancelled({ terminalReason: "client_abort" });

    expect(attempt.terminal?.outcome).toBe("valid_terminal");
    expect(attempt.terminal?.terminalReason).toBe("terminal");
  });
});
