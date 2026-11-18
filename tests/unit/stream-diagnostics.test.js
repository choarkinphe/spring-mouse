// Content-free SSE diagnostics for streams that end without a protocol terminal.
//
// Production sees Claude `/v1/messages` turns that answer HTTP 200, send one
// short chunk, and then end with no `message_stop` and no model output. The raw
// upstream body is never retained, so the only way to tell "metadata only" from
// "unparseable body" from "truncated mid-stream" is to record the event shapes.
// These tests pin that record and prove it carries no payload text.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
}));

import { createSSEStream } from "../../open-sse/utils/stream.js";
import { createStreamDiagnostics, formatStreamDiagnostics, summarizeSSEBody } from "../../open-sse/utils/streamDiagnostics.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

const encoder = new TextEncoder();

async function run(text, { mode = "passthrough", targetFormat = "claude", sourceFormat = "claude" } = {}) {
  const completed = vi.fn();
  const transform = createSSEStream({
    mode, targetFormat, sourceFormat,
    provider: "fixture", model: "m",
    completedContentMaxChars: 0,
    onStreamComplete: completed,
  });
  const writer = transform.writable.getWriter();
  const drained = new Response(transform.readable).text();
  await writer.write(encoder.encode(text));
  await writer.close();
  await drained;
  return completed.mock.calls.at(-1)[3];
}

const frame = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;

describe("stream diagnostics", () => {
  it("records an event-type census for a metadata-only Claude stream", async () => {
    const terminal = await run([
      frame("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 0 } } }),
      "event: ping\ndata: {\"type\":\"ping\"}\n\n",
    ].join(""));

    expect(terminal.terminalReason).toBe("empty_stream");
    const d = terminal.streamDiagnostics;
    expect(d.parsedEvents).toBe(2);
    expect(d.parseFailures).toBe(0);
    expect(d.eventTypes).toEqual({ message_start: 1, ping: 1 });
    expect(d.firstEventType).toBe("message_start");
    expect(d.lastEventType).toBe("ping");
    expect(d.firstParsedType).toBe("message_start");
    expect(d.upstreamChunks).toBeGreaterThan(0);
    expect(d.upstreamBytes).toBeGreaterThan(0);
    expect(d.doneSentinelSeen).toBe(false);
  });

  it("records the shape of a non-SSE body without keeping its text", async () => {
    const terminal = await run("<html><body>upstream gateway error</body></html>\n");
    const d = terminal.streamDiagnostics;

    // Not SSE framing at all, so it is classified as a body line, not a parse
    // failure of a `data:` payload.
    expect(d.otherLines).toBe(1);
    expect(d.bodyShapes).toEqual({ html: 1 });
    expect(d.parseFailures).toBe(0);
    // Only lengths are kept, never content.
    expect(d.maxBodyLineLength).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain("gateway error");
    expect(JSON.stringify(d)).not.toContain("<html>");
  });

  it("records a data payload that is not valid JSON", async () => {
    const terminal = await run("data: upstream overloaded, retry later\n\nevent: message_start\ndata: {\"type\":\"message_start\"}\n\n");
    const d = terminal.streamDiagnostics;

    expect(d.parseFailures).toBe(1);
    expect(d.unparsedShapes).toEqual({ text: 1 });
    expect(d.eventTypes).toEqual({ message_start: 1 });
    expect(JSON.stringify(d)).not.toContain("overloaded");
  });

  it("separates a truncated turn from a metadata-only one", async () => {
    const terminal = await run([
      frame("message_start", { type: "message_start", message: { id: "msg_1" } }),
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }),
    ].join(""));
    const d = terminal.streamDiagnostics;

    expect(terminal.terminalReason).toBe("incomplete");
    expect(d.eventTypes).toEqual({ message_start: 1, content_block_start: 1, content_block_delta: 1 });
    expect(d.parsedEvents).toBe(3);
  });

  it("also reports on a healthy turn so the two can be compared", async () => {
    const terminal = await run([
      frame("message_start", { type: "message_start", message: { id: "msg_1" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      frame("message_stop", { type: "message_stop" }),
    ].join(""));

    expect(terminal.outcome).toBe("valid_terminal");
    expect(terminal.streamDiagnostics.eventTypes).toEqual({
      message_start: 1, content_block_delta: 1, message_stop: 1,
    });
  });

  it("recognizes the OpenAI done sentinel in a passthrough chat stream", async () => {
    const terminal = await run('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n', {
      targetFormat: "openai", sourceFormat: "openai",
    });

    expect(terminal.streamDiagnostics.doneSentinelSeen).toBe(true);
    expect(terminal.streamDiagnostics.parsedEvents).toBe(1);
  });
});

describe("forced streaming to JSON", () => {
  it("summarizes a buffered body the same way the stream transform does", () => {
    const snapshot = summarizeSSEBody([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'data: upstream overloaded\n\n',
    ].join(""));

    expect(snapshot.eventTypes).toEqual({ message_start: 1, ping: 1 });
    expect(snapshot.parsedEvents).toBe(2);
    expect(snapshot.parseFailures).toBe(1);
    expect(snapshot.unparsedShapes).toEqual({ text: 1 });
    expect(snapshot.upstreamBytes).toBeGreaterThan(0);
    // RETENTION: the buffered body is never kept, only its shape.
    expect(JSON.stringify(snapshot)).not.toContain("overloaded");
  });

  it("counts the done sentinel without treating it as an event", () => {
    const snapshot = summarizeSSEBody('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    expect(snapshot.doneSentinelSeen).toBe(true);
    expect(snapshot.parsedEvents).toBe(1);
    expect(snapshot.parseFailures).toBe(0);
  });
});

describe("persistence and logging", () => {
  function completeWith(terminal) {
    const errorLine = vi.fn();
    const routing = { originalModel: "claude-opus-5-5", executedModel: "claude/claude-sonnet-5-5" };
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "claude", model: "claude-sonnet-5-5",
      routing, connectionId: "conn-1", requestStartTime: Date.now() - 1000,
      requestId: "req-1", endpoint: "/v1/messages",
      body: { messages: [], model: "claude-sonnet-5-5" }, stream: true,
      finalBody: null, translatedBody: null,
      clientRawRequest: { endpoint: "/v1/messages" },
      reqTag: "TAG", log: { errorLine, line: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      observabilityEnabled: true, observabilityMaxJsonChars: 4096,
    });
    onStreamComplete({ content: "", thinking: "", truncated: {} }, null, null, terminal);
    return { errorLine, routing };
  }

  const snapshot = () => createStreamDiagnostics().snapshot();

  it("logs one content-free STREAM-DIAG line for a failed stream", () => {
    const { errorLine } = completeWith({ outcome: "incomplete", terminalReason: "empty_stream", streamDiagnostics: snapshot() });

    expect(errorLine).toHaveBeenCalledOnce();
    const [tag, symbol, message] = errorLine.mock.calls[0];
    expect(tag).toBe("TAG");
    expect(symbol).toBe("🔬");
    expect(message).toContain("STREAM-DIAG empty_stream");
    expect(message).toContain("claude/claude-sonnet-5-5");
  });

  it("stays quiet for a healthy stream", () => {
    const { errorLine } = completeWith({ outcome: "valid_terminal", terminalReason: "terminal", streamDiagnostics: snapshot() });
    expect(errorLine).not.toHaveBeenCalled();
  });

  it("carries the snapshot into the saved request detail", () => {
    const { routing } = completeWith({ outcome: "incomplete", terminalReason: "empty_stream", streamDiagnostics: snapshot() });

    expect(routing.streamDiagnostics).toMatchObject({ parsedEvents: 0, parseFailures: 0 });
    const detail = saveRequestDetail.mock.calls.at(-1)[0];
    expect(detail.latency.streamDiagnostics).toMatchObject({ parsedEvents: 0 });
    expect(detail.response.terminalReason).toBe("empty_stream");
  });
});

describe("diagnostics bounds", () => {
  it("caps the event vocabulary and flags overflow", () => {
    const diagnostics = createStreamDiagnostics();
    for (let i = 0; i < 40; i++) diagnostics.noteEventType(`custom_event_${i}`);
    const snapshot = diagnostics.snapshot();

    expect(Object.keys(snapshot.eventTypes).length).toBeLessThanOrEqual(16);
    expect(snapshot.overflowedTypes).toBe(true);
  });

  it("counts NDJSON lines separately from a malformed SSE body", () => {
    const diagnostics = createStreamDiagnostics();
    diagnostics.noteLine('{"message":{"content":"hi"},"done":false}');
    const snapshot = diagnostics.snapshot();

    expect(snapshot.ndjsonLines).toBe(1);
    expect(snapshot.bodyShapes).toEqual({});
    expect(snapshot.parseFailures).toBe(0);
  });

  it("buckets an unsafe event name instead of storing it", () => {
    const diagnostics = createStreamDiagnostics();
    diagnostics.noteEventType("Name With Spaces And A Secret Prompt");
    expect(diagnostics.snapshot().eventTypes).toEqual({ other: 1 });
  });

  it("renders a single content-free log line", () => {
    const diagnostics = createStreamDiagnostics();
    diagnostics.noteLine('event: message_start');
    diagnostics.noteLine('data: {"type":"message_start"}');
    diagnostics.noteParsedEvent();
    const line = formatStreamDiagnostics(diagnostics.snapshot());

    expect(line).toContain("events=[message_start=1]");
    expect(line).toContain("parsed=1");
    expect(line).toContain("parse_failures=0");
    expect(formatStreamDiagnostics(null)).toBe("none");
  });
});
