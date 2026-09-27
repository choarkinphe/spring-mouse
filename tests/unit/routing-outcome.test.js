// Isolated explicit protocol-terminal routing observer.
//
// The observer answers one question per attempt: did the upstream reach a REAL
// protocol terminal (finish_reason / message_stop / response.completed / ...),
// as opposed to merely answering HTTP 200, sending the synthetic `[DONE]`
// sentinel, or flushing the stream? These tests pin the classification table,
// the observer contract, and the wiring through the streaming / non-streaming /
// forced-SSE-to-JSON paths.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
}));

import {
  ROUTING_OUTCOMES,
  TERMINAL_REASONS,
  STREAM_MODES,
  classifyStreamEvent,
  classifyOpenAIChatChunk,
  classifyResponsesEvent,
  classifyClaudeEvent,
  classifyGeminiEvent,
  classifyJsonBody,
  classifyRawSSEBlock,
  hasContentForFormat,
  normalizeRoutingTokens,
  createRoutingObserver,
} from "../../open-sse/utils/routingOutcome.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

const encoder = new TextEncoder();

// ---- helpers ---------------------------------------------------------------

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseEvent(name, obj) {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/** Drive text through a createSSEStream transform and drain the output. */
async function runSSEStream(text, { mode = "passthrough", targetFormat, sourceFormat, routing }) {
  const ts = createSSEStream({
    mode,
    targetFormat,
    sourceFormat,
    provider: "test-provider",
    model: "test-model",
    onStreamComplete: () => {},
    routing,
  });
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const drain = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    return out;
  })();
  await writer.write(encoder.encode(text));
  await writer.close();
  return drain;
}

function sseResponse(text) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** A recorder observer capturing every callback payload. */
function recorder() {
  const calls = { headers: [], terminal: [], failed: [], cancelled: [], unknown: [] };
  return {
    calls,
    observer: {
      onHeaders: (p) => calls.headers.push(p),
      onTerminal: (p) => calls.terminal.push(p),
      onFailed: (p) => calls.failed.push(p),
      onCancelled: (p) => calls.cancelled.push(p),
      onUnknown: (p) => calls.unknown.push(p),
    },
  };
}

// ---- classification table --------------------------------------------------

describe("OpenAI Chat Completions terminal classification", () => {
  it("treats finish_reason stop / tool_calls / function_call as valid terminals", () => {
    for (const reason of ["stop", "tool_calls", "function_call"]) {
      expect(classifyOpenAIChatChunk({ choices: [{ finish_reason: reason }] }))
        .toEqual({ outcome: ROUTING_OUTCOMES.VALID_TERMINAL, terminalReason: TERMINAL_REASONS.TERMINAL });
    }
  });

  it("treats length / content_filter as explicit but incomplete terminals", () => {
    for (const reason of ["length", "content_filter"]) {
      expect(classifyOpenAIChatChunk({ choices: [{ finish_reason: reason }] }))
        .toEqual({ outcome: ROUTING_OUTCOMES.INCOMPLETE, terminalReason: TERMINAL_REASONS.INCOMPLETE });
    }
  });

  it("treats an error finish_reason or an error chunk as failed", () => {
    expect(classifyOpenAIChatChunk({ choices: [{ finish_reason: "error" }] }).outcome).toBe(ROUTING_OUTCOMES.FAILED);
    expect(classifyOpenAIChatChunk({ error: { message: "boom" } }).outcome).toBe(ROUTING_OUTCOMES.FAILED);
  });

  it("does NOT treat a content delta or a usage-only chunk as a terminal", () => {
    expect(classifyOpenAIChatChunk({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
    expect(classifyOpenAIChatChunk({ choices: [] })).toBeNull();
    expect(classifyOpenAIChatChunk({ usage: { prompt_tokens: 1 } })).toBeNull();
  });
});

describe("OpenAI Responses terminal classification", () => {
  it("maps completed / failed / incomplete events and statuses", () => {
    expect(classifyResponsesEvent("response.completed", { type: "response.completed" }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyResponsesEvent("response.failed", { type: "response.failed" }).outcome).toBe(ROUTING_OUTCOMES.FAILED);
    expect(classifyResponsesEvent("response.incomplete", { type: "response.incomplete" }).outcome).toBe(ROUTING_OUTCOMES.INCOMPLETE);
    expect(classifyResponsesEvent("error", { error: { message: "x" } }).outcome).toBe(ROUTING_OUTCOMES.FAILED);
    expect(classifyResponsesEvent(null, { response: { status: "completed" } }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
  });

  it("does not treat in-progress / delta events as terminals", () => {
    expect(classifyResponsesEvent("response.output_text.delta", { type: "response.output_text.delta" })).toBeNull();
    expect(classifyResponsesEvent(null, { response: { status: "in_progress" } })).toBeNull();
  });
});

describe("Claude terminal classification", () => {
  it("treats message_stop as the terminal", () => {
    expect(classifyClaudeEvent({ type: "message_stop" }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
  });

  it("treats an error event as failed and content deltas as non-terminal", () => {
    expect(classifyClaudeEvent({ type: "error", error: { message: "x" } }).outcome).toBe(ROUTING_OUTCOMES.FAILED);
    expect(classifyClaudeEvent({ type: "content_block_delta", delta: { text: "hi" } })).toBeNull();
    expect(classifyClaudeEvent({ type: "message_start" })).toBeNull();
  });
});

describe("Gemini terminal classification", () => {
  it("maps finishReason STOP / MAX_TOKENS / SAFETY", () => {
    expect(classifyGeminiEvent({ candidates: [{ finishReason: "STOP" }] }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyGeminiEvent({ candidates: [{ finishReason: "MAX_TOKENS" }] }).outcome).toBe(ROUTING_OUTCOMES.INCOMPLETE);
    expect(classifyGeminiEvent({ candidates: [{ finishReason: "SAFETY" }] }).outcome).toBe(ROUTING_OUTCOMES.FAILED);
    expect(classifyGeminiEvent({ candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED" }] })).toBeNull();
    expect(classifyGeminiEvent({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBeNull();
    expect(classifyGeminiEvent({ promptFeedback: { blockReason: "SAFETY" } }).outcome).toBe(ROUTING_OUTCOMES.FAILED);
  });
});

describe("classifyStreamEvent dispatch", () => {
  it("routes by upstream format", () => {
    expect(classifyStreamEvent(FORMATS.OPENAI, null, { choices: [{ finish_reason: "stop" }] }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyStreamEvent(FORMATS.CLAUDE, null, { type: "message_stop" }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyStreamEvent(FORMATS.GEMINI, null, { candidates: [{ finishReason: "STOP" }] }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyStreamEvent(FORMATS.OPENAI_RESPONSES, "response.completed", {}).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
  });
});

describe("non-streaming JSON classification", () => {
  it("classifies OpenAI bodies (valid / incomplete / error)", () => {
    expect(classifyJsonBody({ choices: [{ finish_reason: "stop" }] }, FORMATS.OPENAI).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyJsonBody({ choices: [{ finish_reason: "length" }] }, FORMATS.OPENAI).outcome).toBe(ROUTING_OUTCOMES.INCOMPLETE);
    expect(classifyJsonBody({ error: { message: "x" } }, FORMATS.OPENAI).outcome).toBe(ROUTING_OUTCOMES.FAILED);
  });

  it("classifies Claude / Gemini / Responses bodies", () => {
    expect(classifyJsonBody({ type: "message", stop_reason: "end_turn" }, FORMATS.CLAUDE).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyJsonBody({ type: "message", stop_reason: "max_tokens" }, FORMATS.CLAUDE).outcome).toBe(ROUTING_OUTCOMES.INCOMPLETE);
    expect(classifyJsonBody({ candidates: [{ finishReason: "STOP" }] }, FORMATS.GEMINI).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyJsonBody({ status: "completed", output: [] }, FORMATS.OPENAI_RESPONSES).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
    expect(classifyJsonBody({ status: "failed" }, FORMATS.OPENAI_RESPONSES).outcome).toBe(ROUTING_OUTCOMES.FAILED);
  });

  it("does not read an un-terminated status as valid unless lenient", () => {
    expect(classifyJsonBody({ status: "in_progress" }, FORMATS.OPENAI_RESPONSES).outcome).toBe(ROUTING_OUTCOMES.UNKNOWN);
    // Lenient (the ordinary JSON path) accepts an unrecognized 200 body as done.
    expect(classifyJsonBody({ choices: [{ message: { content: "x" } }] }, FORMATS.OPENAI, { lenient: true }).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
  });
});

describe("raw SSE block classification (forced-streaming → JSON)", () => {
  it("finds a real terminal in a completed Responses stream", () => {
    const text = sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" })
      + sseEvent("response.completed", { type: "response.completed", response: { status: "completed" } });
    expect(classifyRawSSEBlock(text, FORMATS.OPENAI_RESPONSES).outcome).toBe(ROUTING_OUTCOMES.VALID_TERMINAL);
  });

  it("reports failure when an error frame follows a delta", () => {
    const text = sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" })
      + sseEvent("error", { error: { code: "server_is_overloaded" } });
    expect(classifyRawSSEBlock(text, FORMATS.OPENAI_RESPONSES).outcome).toBe(ROUTING_OUTCOMES.FAILED);
  });

  it("returns null for a stream that never reached a terminal (only [DONE])", () => {
    const text = sse({ choices: [{ delta: { content: "hi" } }] }) + "data: [DONE]\n\n";
    expect(classifyRawSSEBlock(text, FORMATS.OPENAI)).toBeNull();
  });
});

describe("hasContentForFormat / token normalization", () => {
  it("detects content-bearing events for TTFT", () => {
    expect(hasContentForFormat(FORMATS.OPENAI, { choices: [{ delta: { content: "x" } }] })).toBe(true);
    expect(hasContentForFormat(FORMATS.OPENAI, { choices: [{ finish_reason: "stop" }] })).toBe(false);
    expect(hasContentForFormat(FORMATS.CLAUDE, { type: "content_block_delta", delta: { text: "x" } })).toBe(true);
    expect(hasContentForFormat(FORMATS.GEMINI, { candidates: [{ content: { parts: [{ text: "x" }] } }] })).toBe(true);
  });

  it("normalizes OpenAI / Claude / Gemini usage shapes", () => {
    expect(normalizeRoutingTokens({ prompt_tokens: 5, completion_tokens: 7 })).toEqual({ promptTokens: 5, completionTokens: 7 });
    expect(normalizeRoutingTokens({ input_tokens: 5, output_tokens: 7 })).toEqual({ promptTokens: 5, completionTokens: 7 });
    expect(normalizeRoutingTokens({ promptTokenCount: 5, candidatesTokenCount: 7 })).toEqual({ promptTokens: 5, completionTokens: 7 });
    expect(normalizeRoutingTokens(null)).toEqual({ promptTokens: null, completionTokens: null });
  });
});

// ---- observer contract -----------------------------------------------------

describe("createRoutingObserver", () => {
  it("returns null when no observer is supplied", () => {
    expect(createRoutingObserver({ observer: null })).toBeNull();
  });

  it("emits headers once and settles on the recorded terminal", () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer, requestStartTime: Date.now() - 120 });
    routing.emitHeaders({ status: 200, sourceFormat: "openai", targetFormat: "claude", streamMode: STREAM_MODES.STREAM, nativePassthrough: true });
    routing.emitHeaders({ status: 500 }); // ignored — headers emitted once
    routing.recordTerminal({ outcome: ROUTING_OUTCOMES.VALID_TERMINAL, terminalReason: TERMINAL_REASONS.TERMINAL });
    routing.settle({ usage: { prompt_tokens: 3, completion_tokens: 4 } });

    expect(calls.headers).toHaveLength(1);
    expect(calls.headers[0]).toEqual({ status: 200, sourceFormat: "openai", targetFormat: "claude", streamMode: "stream", nativePassthrough: true });

    expect(calls.terminal).toHaveLength(1);
    const payload = calls.terminal[0];
    expect(payload.outcome).toBe("valid_terminal");
    expect(payload.terminalReason).toBe("terminal");
    expect(payload.promptTokens).toBe(3);
    expect(payload.completionTokens).toBe(4);
    expect(payload.upstreamStatus).toBeNull();
    // No content-bearing event was observed, so TTFT stays unknown.
    expect(payload.ttftMs).toBeNull();
    expect(typeof payload.durationMs).toBe("number");
    expect(payload.durationMs).toBeGreaterThanOrEqual(100);
  });

  it("routes failed / cancelled outcomes to their callbacks", () => {
    const failed = recorder();
    const r1 = createRoutingObserver({ observer: failed.observer });
    r1.settleFailed({ upstreamStatus: 502 });
    expect(failed.calls.failed).toHaveLength(1);
    expect(failed.calls.failed[0].outcome).toBe("failed");
    expect(failed.calls.failed[0].upstreamStatus).toBe(502);
    expect(failed.calls.terminal).toHaveLength(0);

    const cancelled = recorder();
    const r2 = createRoutingObserver({ observer: cancelled.observer });
    r2.settleCancelled();
    expect(cancelled.calls.cancelled).toHaveLength(1);
    expect(cancelled.calls.cancelled[0].outcome).toBe("cancelled");
  });

  it("settles exactly once", () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    routing.settle({ outcome: ROUTING_OUTCOMES.INCOMPLETE, terminalReason: TERMINAL_REASONS.INCOMPLETE });
    routing.settleFailed();
    routing.settleCancelled();
    expect(calls.terminal).toHaveLength(1);
    expect(calls.failed).toHaveLength(0);
    expect(calls.cancelled).toHaveLength(0);
  });

  it("lets a recorded protocol terminal outrank a later cancel/error", () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    routing.recordTerminal({ outcome: ROUTING_OUTCOMES.VALID_TERMINAL, terminalReason: TERMINAL_REASONS.TERMINAL });
    routing.settleCancelled();
    expect(calls.terminal).toHaveLength(1);
    expect(calls.cancelled).toHaveLength(0);
  });

  it("is fail-open: a throwing observer never throws out of the emit path", () => {
    const routing = createRoutingObserver({
      observer: {
        onTerminal: () => { throw new Error("observer boom"); },
        onHeaders: () => { throw new Error("observer boom"); },
      },
    });
    expect(() => routing.emitHeaders({ status: 200 })).not.toThrow();
    expect(() => routing.settle({ outcome: ROUTING_OUTCOMES.VALID_TERMINAL })).not.toThrow();
  });
});

// ---- streaming wiring ------------------------------------------------------

describe("streaming observer wiring", () => {
  it("reports a valid terminal for an OpenAI finish_reason stream", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    await runSSEStream(
      sse({ choices: [{ delta: { content: "hi" } }] }) + sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n",
      { mode: "passthrough", targetFormat: FORMATS.OPENAI, routing },
    );
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].outcome).toBe("valid_terminal");
    expect(calls.terminal[0].ttftMs).not.toBeNull();
  });

  it("reports incomplete when the stream ends with only the synthetic [DONE]", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    await runSSEStream(
      sse({ choices: [{ delta: { content: "hi" } }] }) + "data: [DONE]\n\n",
      { mode: "passthrough", targetFormat: FORMATS.OPENAI, routing },
    );
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].outcome).toBe("incomplete");
    expect(calls.terminal[0].terminalReason).toBe("incomplete");
  });

  it("reports failed for an in-stream error chunk", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    await runSSEStream(
      sse({ choices: [{ delta: { content: "hi" } }] }) + sse({ error: { message: "overloaded" } }),
      { mode: "passthrough", targetFormat: FORMATS.OPENAI, routing },
    );
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0].outcome).toBe("failed");
  });

  it("is a no-op without an observer", async () => {
    await expect(runSSEStream(sse({ choices: [{ finish_reason: "stop" }] }), {
      mode: "passthrough", targetFormat: FORMATS.OPENAI, routing: null,
    })).resolves.toBeTypeOf("string");
  });
});

// ---- forced SSE → JSON wiring ---------------------------------------------

function forcedCtx(raw, { sourceFormat = FORMATS.OPENAI_RESPONSES, targetFormat = FORMATS.OPENAI_RESPONSES, provider = "codex", routing } = {}) {
  return {
    providerResponse: sseResponse(raw),
    sourceFormat,
    targetFormat,
    provider,
    model: "gpt-5.6-sol",
    body: { model: "gpt-5.6-sol", input: "hi" },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    clientRawRequest: { endpoint: "/v1/responses" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    log: {},
    routing,
  };
}

describe("forced SSE → JSON observer wiring", () => {
  it("reports a valid terminal for a completed Responses stream", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    const raw = sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" })
      + sseEvent("response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } });
    const result = await handleForcedSSEToJson(forcedCtx(raw, { routing }));
    expect(result.success).toBe(true);
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].outcome).toBe("valid_terminal");
    expect(calls.terminal[0].promptTokens).toBe(3);
    expect(calls.terminal[0].completionTokens).toBe(1);
  });

  it("reports failed for an errored Responses stream", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    const raw = sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" })
      + sseEvent("error", { error: { code: "server_is_overloaded", message: "overloaded" } });
    const result = await handleForcedSSEToJson(forcedCtx(raw, { routing }));
    expect(result.success).toBe(false);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0].outcome).toBe("failed");
  });

  it("reports a valid terminal for a standard chat SSE with finish_reason", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    const raw = sse({ choices: [{ delta: { content: "hi" } }] }) + sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
    const result = await handleForcedSSEToJson(forcedCtx(raw, { sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, provider: "deepseek", routing }));
    expect(result.success).toBe(true);
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].outcome).toBe("valid_terminal");
  });

  it("reports incomplete for a chat SSE that never sent a finish_reason", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    const raw = sse({ choices: [{ delta: { content: "hi" } }] }) + "data: [DONE]\n\n";
    await handleForcedSSEToJson(forcedCtx(raw, { sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, provider: "deepseek", routing }));
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].outcome).toBe("incomplete");
  });
});

// ---- non-streaming JSON wiring --------------------------------------------

function nonStreamCtx(response, { routing } = {}) {
  return {
    providerResponse: response,
    provider: "openai-compatible",
    model: "gpt-x",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { model: "gpt-x", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: undefined,
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    log: {},
    routing,
  };
}

describe("non-streaming observer wiring", () => {
  it("emits headers with the JSON stream mode and nativePassthrough flag", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    const body = { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };
    await handleNonStreamingResponse({ ...nonStreamCtx(jsonResponse(body), { routing }), nativePassthrough: true });
    expect(calls.headers).toHaveLength(1);
    expect(calls.headers[0].streamMode).toBe("json");
    expect(calls.headers[0].nativePassthrough).toBe(true);
  });

  it("reports a valid terminal for a normal JSON completion", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    const body = { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    const result = await handleNonStreamingResponse(nonStreamCtx(jsonResponse(body), { routing }));
    expect(result.success).toBe(true);
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].outcome).toBe("valid_terminal");
    expect(calls.terminal[0].promptTokens).toBe(5);
    expect(calls.terminal[0].completionTokens).toBe(2);
  });

  it("reports incomplete for a length-truncated JSON completion", async () => {
    const { calls, observer } = recorder();
    const routing = createRoutingObserver({ observer });
    const body = { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "length" }] };
    await handleNonStreamingResponse(nonStreamCtx(jsonResponse(body), { routing }));
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0].outcome).toBe("incomplete");
  });

  it("does not disturb the response when no observer is attached", async () => {
    const body = { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };
    const result = await handleNonStreamingResponse(nonStreamCtx(jsonResponse(body), { routing: null }));
    expect(result.success).toBe(true);
    const parsed = await result.response.json();
    expect(parsed.choices[0].message.content).toBe("hi");
  });
});
