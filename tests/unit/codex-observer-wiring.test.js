/**
 * Wiring guard for the routing-telemetry observer.
 *
 * The telemetry feature spans a boundary where two different observer interfaces
 * meet:
 *
 *   src/sse/services/routingTelemetry.js  → the raw protocol observer
 *                                           (onHeaders/onTerminal/onFailed/…)
 *   open-sse/utils/routingOutcome.js      → the fail-open wrapper
 *                                           (emitHeaders/recordTerminal/settle/…)
 *
 * Every chatCore response path drives the WRAPPER interface. chat.js used to pass
 * the raw observer straight through, so the very first response — streaming,
 * non-streaming and SSE→JSON alike — threw
 *
 *   TypeError: routingObserver.emitHeaders is not a function
 *
 * at streamingHandler.js:93, before a single byte reached the client. That is a
 * 500 on every chat request, and it is invisible to the existing suite because
 * chat-routing-telemetry.test.js mocks handleChatCore — i.e. it mocks out exactly
 * the boundary that was wrong, and then drives the raw interface by hand.
 *
 * This file therefore does NOT mock the pipeline: it builds the observer the way
 * chat.js does and pushes a real upstream SSE stream through the real
 * handleStreamingResponse. If the two interfaces drift apart again, this fails.
 */
import { describe, expect, it } from "vitest";

import { createRoutingTelemetrySession } from "@/sse/services/routingTelemetry.js";
import { createRoutingObserver } from "open-sse/utils/routingOutcome.js";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";

/** Exactly what chat.js#openAttempt does to the session's observer. */
function wiredObserver(session, { requestStartTime = Date.now() } = {}) {
  const attempt = session.openAttempt({
    modelCallId: "model-call-1", role: "primary",
    provider: "codex", model: "gpt-6-astra", connectionId: "conn-1",
  });
  const observer = createRoutingObserver({ observer: attempt.observer, requestStartTime });
  return { attempt, observer };
}

function sseResponse(text, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(text)); c.close(); },
  }), { status, headers: { "Content-Type": "text/event-stream" } });
}

const CODEX_SSE =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n'
  + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'
  + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n';

const silentLog = { warn() {}, info() {}, debug() {}, error() {} };

/** A streamController shaped enough for pipeWithDisconnect to run. */
function stubStreamController() {
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => true,
    handleComplete() {},
    onDisconnect() {},
    onFirstByte() {},
  };
}

async function driveStreaming(observer, { sourceFormat = "openai-responses", targetFormat = "openai", body = CODEX_SSE } = {}) {
  return handleStreamingResponse({
    providerResponse: sseResponse(body),
    provider: "codex", model: "gpt-6-astra", originalModel: "gpt-6-astra",
    executedModel: "codex/gpt-6-astra", routing: {}, routingObserver: observer,
    sourceFormat, targetFormat, userAgent: "test",
    body: {}, stream: true, translatedBody: {}, finalBody: {},
    requestStartTime: Date.now(), requestId: "req-1", trafficRequestId: "traffic-1",
    startedAt: new Date().toISOString(), connectionId: "conn-1", mouse: null,
    apiKey: null, clientRawRequest: { headers: {} }, onRequestSuccess: null,
    reqLogger: { close() {} }, toolNameMap: null, customToolNames: null,
    streamController: stubStreamController(), onStreamComplete: null,
    streamDetailId: null, pxpipe: null, reqTag: null, log: silentLog,
    observabilityEnabled: false, observabilityMaxJsonChars: 0, recordUsage: false,
  });
}

describe("routing observer wiring", () => {
  it("the wired observer exposes the interface the response paths call", () => {
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const { observer } = wiredObserver(session);
    for (const method of ["emitHeaders", "recordTerminal", "settle", "noteFirstToken", "hasTerminal"]) {
      expect(typeof observer[method], `observer.${method} must be a function`).toBe("function");
    }
  });

  it("does not throw on the first streaming response and returns the client stream", async () => {
    const session = createRoutingTelemetrySession({ endpoint: "/v1/chat/completions", trafficRequestId: "t" });
    const { observer } = wiredObserver(session);

    const out = await driveStreaming(observer);

    expect(out).toBeDefined();
    expect(out.response.status).toBe(200);
    // The response body must still be the client's SSE, i.e. telemetry did not
    // replace or consume it.
    await expect(out.response.text()).resolves.toContain("data:");
  });

  it("still delivers the stream when the observer callback itself throws", async () => {
    // The wrapper exists to make a broken observer inert. A raw observer that
    // throws must not be able to break the client response.
    const throwing = {
      onHeaders() { throw new Error("observer onHeaders blew up"); },
      onTerminal() { throw new Error("observer onTerminal blew up"); },
      onFailed() { throw new Error("observer onFailed blew up"); },
      onCancelled() {},
      onUnknown() {},
    };
    const observer = createRoutingObserver({ observer: throwing, requestStartTime: Date.now() });

    const out = await driveStreaming(observer);

    expect(out.response.status).toBe(200);
    await expect(out.response.text()).resolves.toContain("data:");
  });
});
