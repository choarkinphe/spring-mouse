// A Responses-API provider can fail a turn *after* streaming a few deltas — most
// commonly `server_is_overloaded`. The stream-to-JSON converter used to record
// `status: "failed"` but drop the reason, and the non-streaming handler ignored the
// status entirely: it recorded usage and returned the empty/partial body as a 200
// success, so the combo never rotated to the next model and the client was handed
// the overload text. These pin both halves of the fix.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const OVERLOAD_MESSAGE = "Our servers are currently overloaded. Please try again later.";

const outputDelta = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"Sure"}',
  "",
  "",
].join("\n");

const errorFrame = [
  "event: error",
  `data: {"error":{"code":"server_is_overloaded","message":"${OVERLOAD_MESSAGE}"}}`,
  "",
  "",
].join("\n");

const failedFrame = [
  "event: response.failed",
  `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_is_overloaded","message":"${OVERLOAD_MESSAGE}"}}}`,
  "",
  "",
].join("\n");

describe("Responses SSE → JSON failure detection", () => {
  it("marks an `event: error` frame as failed and keeps its message", async () => {
    const result = await convertResponsesStreamToJson(streamFromText(errorFrame));
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(OVERLOAD_MESSAGE);
  });

  it("marks `response.failed` as failed and keeps its message", async () => {
    const result = await convertResponsesStreamToJson(streamFromText(failedFrame));
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(OVERLOAD_MESSAGE);
  });

  it("reports failure even when output deltas preceded the error", async () => {
    const result = await convertResponsesStreamToJson(streamFromText(outputDelta + errorFrame));
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(OVERLOAD_MESSAGE);
  });

  it("leaves a completed turn untouched", async () => {
    const text = [
      outputDelta,
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
      "",
    ].join("\n");

    const result = await convertResponsesStreamToJson(streamFromText(text));
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.usage.total_tokens).toBe(4);
  });
});

// The non-streaming entry point (a Responses client that is served by a forced-
// streaming provider) must propagate the failure so chat.js marks the account and
// the combo rotates. Before the fix it returned success:true for a failed stream.
describe("handleForcedSSEToJson surfaces a failed Responses stream", () => {
  function ctx(raw) {
    const encoder = new TextEncoder();
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      model: "gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "hi" },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      log: {},
    };
  }

  it("returns an error result (not 200 OK) for a failed stream", async () => {
    const result = await handleForcedSSEToJson(ctx(outputDelta + errorFrame));
    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain("overloaded");
    expect(result.upstreamError?.source).toBe("sse");
  });

  it("still succeeds for a completed stream", async () => {
    const raw = [
      outputDelta,
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
      "",
    ].join("\n");
    const result = await handleForcedSSEToJson(ctx(raw));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
  });
});
