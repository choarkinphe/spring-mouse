import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/transformer/streamToJsonConverter.js", () => ({
  convertResponsesStreamToJson: vi.fn(),
}));

import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

afterEach(() => vi.restoreAllMocks());

function context(body) {
  return {
    providerResponse: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    provider: "codex", model: "fixture-model", body: {}, stream: false,
    sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
    requestStartTime: Date.now(), trackDone: vi.fn(), appendLog: vi.fn(), log: {}, recordUsage: false,
  };
}

const completed = { id: "fixture", status: "completed", output: [], usage: {} };

describe("forced Responses SSE to JSON cancellation", () => {
  it("waits for diagnostic wrapper cleanup and consumes a rejected cancel promise", async () => {
    const reason = Object.assign(new Error("client disconnected"), { name: "ResponseAborted" });
    let rejectCancel;
    const pending = new Promise((_, reject) => { rejectCancel = reject; });
    pending.catch(() => {});
    const cancel = vi.fn(() => pending);
    let settled = false;
    let startCancel;
    const cancelling = new Promise(resolve => { startCancel = resolve; });
    convertResponsesStreamToJson.mockImplementationOnce(async stream => {
      const result = stream.cancel(reason);
      startCancel();
      await result;
      settled = true;
      return completed;
    });
    const ctx = context(new ReadableStream({ cancel }));
    const handling = handleForcedSSEToJson(ctx);
    await cancelling;
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeCleanup = settled;
    rejectCancel(reason);
    const result = await handling;
    expect(settledBeforeCleanup).toBe(false);
    expect(result.success).toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(ctx.trackDone).toHaveBeenCalledOnce();
  });

  it("handles an upstream that errors before the diagnostic wrapper is cancelled", async () => {
    const reason = Object.assign(new Error("client disconnected"), { name: "ResponseAborted" });
    let controller;
    const upstream = new ReadableStream({ start(c) { controller = c; } });
    convertResponsesStreamToJson.mockImplementationOnce(async stream => {
      controller.error(reason);
      await stream.cancel(reason);
      return completed;
    });
    const result = await handleForcedSSEToJson(context(upstream));
    await new Promise(resolve => setImmediate(resolve));
    expect(result.success).toBe(true);
  });
});
