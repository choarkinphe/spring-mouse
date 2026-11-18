// A provider that answers `stream: true` with one whole JSON reply.
//
// Production saw Claude `/v1/messages` turns answered HTTP 200 with a single
// ~607-byte JSON body and no SSE framing at all: read as a stream, that reply
// carries no event, so the turn ended as `empty_stream` even though the provider
// had answered. Magpie re-frames such a reply into the stream its own protocol
// would have sent (`internal/gateway/whole_stream.go`); these tests pin the same
// behaviour here, and prove the re-framed stream is what the existing terminal
// classifier and translators already understand.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

import {
  bodyStartsAsSSE,
  wholeReplyAsStream,
  wholeReplyToSSE,
  claudeWholeReplyToSSE,
  openAIWholeReplyToSSE,
} from "../../open-sse/handlers/chatCore/wholeReplyStream.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { classifyStreamEvent, ROUTING_OUTCOMES, TERMINAL_REASONS } from "../../open-sse/utils/routingOutcome.js";

const encoder = new TextEncoder();

/** A provider response carrying a raw string body and a Content-Type. */
function upstream(body, contentType = "application/json", status = 200) {
  const headers = contentType ? { "content-type": contentType } : {};
  return new Response(body, { status, headers });
}

async function readAll(response) {
  return response.text();
}

/** Parse an SSE payload into `{ event, data }` frames. */
function frames(text) {
  const out = [];
  for (const block of String(text).split("\n\n")) {
    const frame = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("data: ")) frame.data = line.slice(6);
    }
    if (frame.data !== undefined) out.push(frame);
  }
  return out;
}

/** The JSON payloads of an SSE body, dropping the `[DONE]` sentinel. */
function payloads(text) {
  return frames(text)
    .filter((frame) => frame.data !== "[DONE]")
    .map((frame) => JSON.parse(frame.data));
}

/** Run text through the real stream transform, as the gateway does. */
async function throughStream(text, sourceFormat = "claude") {
  const completed = vi.fn();
  const transform = createSSEStream({
    mode: "passthrough", targetFormat: sourceFormat, sourceFormat,
    provider: "fixture", model: "m", completedContentMaxChars: 0,
    onStreamComplete: completed,
  });
  const writer = transform.writable.getWriter();
  const drained = new Response(transform.readable).text();
  await writer.write(encoder.encode(text));
  await writer.close();
  await drained;
  return completed.mock.calls.at(-1)[3];
}

const CLAUDE_MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "Hello there" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 3 },
};

describe("stream detection", () => {
  it.each([
    ["event: message_start\ndata: {}\n\n", true],
    ["data: {}\n\n", true],
    [": ping\n\n", true],
    ['{"type":"message"}', false],
    ['  \n\t{"type":"message"}', false],
    ["<html>", false],
  ])("classifies %j as SSE: %s", (text, expected) => {
    expect(bodyStartsAsSSE(text)).toBe(expected);
  });
});

describe("Claude whole reply to Messages SSE", () => {
  it("expands a whole message into the canonical event lifecycle", () => {
    const text = claudeWholeReplyToSSE(CLAUDE_MESSAGE);
    const parsed = payloads(text);

    expect(parsed.map((p) => p.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // message_start carries the reply with no content and zeroed output usage.
    expect(parsed[0].message.content).toEqual([]);
    expect(parsed[0].message.usage).toMatchObject({ input_tokens: 12, output_tokens: 0 });
    // The block is announced empty, then delivered as a delta.
    expect(parsed[1].content_block).toMatchObject({ type: "text", text: "" });
    expect(parsed[2].delta).toEqual({ type: "text_delta", text: "Hello there" });
    // message_delta carries the stop details and the real usage.
    expect(parsed[4].delta.stop_reason).toBe("end_turn");
    expect(parsed[4].usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  it("carries tool_use input as an input_json_delta", () => {
    const text = claudeWholeReplyToSSE({
      ...CLAUDE_MESSAGE,
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
      stop_reason: "tool_use",
    });
    const parsed = payloads(text);
    const start = parsed.find((p) => p.type === "content_block_start");
    const delta = parsed.find((p) => p.delta?.type === "input_json_delta");

    expect(start.content_block).toMatchObject({ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} });
    expect(JSON.parse(delta.delta.partial_json)).toEqual({ city: "Paris" });
  });

  it("keeps a thinking block's signature as its own delta", () => {
    const text = claudeWholeReplyToSSE({
      ...CLAUDE_MESSAGE,
      content: [
        { type: "thinking", thinking: "let me think", signature: "sig" },
        { type: "text", text: "done" },
      ],
    });
    const parsed = payloads(text);
    const thinking = parsed.find((p) => p.delta?.type === "thinking_delta");
    const signature = parsed.find((p) => p.delta?.type === "signature_delta");

    expect(thinking.delta.thinking).toBe("let me think");
    expect(signature.delta.signature).toBe("sig");
  });

  it("rejects a body that is not a Message", () => {
    expect(claudeWholeReplyToSSE({ type: "error", error: {} })).toBeNull();
    expect(claudeWholeReplyToSSE({ choices: [] })).toBeNull();
    expect(claudeWholeReplyToSSE(null)).toBeNull();
  });
});

describe("OpenAI whole reply to Chat SSE", () => {
  it("expands a completion into deltas, a finish chunk and [DONE]", () => {
    const text = openAIWholeReplyToSSE({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });

    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    const parsed = payloads(text);
    expect(parsed[0].choices[0].delta).toMatchObject({ role: "assistant", content: "hi" });
    expect(parsed[0].choices[0].finish_reason).toBeNull();
    // The finish goes out on its own chunk, carrying usage.
    const finish = parsed.at(-1);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 1 });
  });

  it("renumbers tool calls and drops one that names no function", () => {
    const text = openAIWholeReplyToSSE({
      id: "chatcmpl-2",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "get_weather", arguments: "{}" } },
            { id: "b", type: "function", function: { arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    });
    const parsed = payloads(text);
    const delta = parsed[0].choices[0].delta;

    expect(delta.tool_calls).toHaveLength(1);
    expect(delta.tool_calls[0]).toMatchObject({ index: 0, id: "a" });
    // The kept call still finishes as a tool call, so the turn is not relabelled.
    expect(parsed.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("re-framing a provider response", () => {
  it("turns a whole Claude reply into a stream the classifier calls terminal", async () => {
    const response = await wholeReplyAsStream(upstream(JSON.stringify(CLAUDE_MESSAGE)), "claude");

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await readAll(response);
    const terminal = await throughStream(text, "claude");

    expect(terminal.outcome).toBe("valid_terminal");
    expect(terminal.terminalReason).toBe(TERMINAL_REASONS.TERMINAL);
  });

  it("leaves a real SSE stream untouched", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const original = upstream(sse, "text/event-stream");
    expect(await wholeReplyAsStream(original, "claude")).toBeNull();
  });

  it("leaves an SSE body alone even when the Content-Type says JSON", async () => {
    const sse = 'data: {"type":"message_stop"}\n\n';
    const response = await wholeReplyAsStream(upstream(sse, "application/json"), "claude");

    // Not re-framed: the bytes are handed back exactly as they came.
    expect(await readAll(response)).toBe(sse);
  });

  it("leaves an unparseable body alone rather than inventing a reply", async () => {
    const text = "upstream degraded, try again";
    const response = await wholeReplyAsStream(upstream(text, "text/plain"), "claude");
    expect(await readAll(response)).toBe(text);
  });

  it("does not buffer a long NDJSON stream to decide it is not a reply", async () => {
    let released = 0;
    const lines = Array.from({ length: 200 }, (_, i) => `{"n":${i}}\n`);
    // The pull-based source records how much the converter took. A converter
    // that held the whole body would drain every line before answering.
    const source = new ReadableStream({
      pull(controller) {
        if (released >= lines.length) { controller.close(); return; }
        controller.enqueue(encoder.encode(lines[released++]));
      },
    });
    const response = await wholeReplyAsStream(
      new Response(source, { status: 200, headers: { "content-type": "text/plain" } }),
      "claude",
    );

    // It answered without draining the stream...
    expect(released).toBeLessThan(lines.length);
    // ...and every byte is still there for whoever reads it.
    const echoed = await readAll(response);
    expect(echoed).toContain('{"n":0}');
    expect(echoed).toContain('{"n":199}');
  });

  it("does nothing for a reply already in a format it cannot re-frame", async () => {
    const body = JSON.stringify({ candidates: [] });
    const response = await wholeReplyAsStream(upstream(body), "gemini");
    expect(await readAll(response)).toBe(body);
  });

  it("keeps an upstream error as an error event, not an empty reply", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const response = await wholeReplyAsStream(upstream(body), "claude");
    const text = await readAll(response);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const parsed = payloads(text);
    expect(parsed[0]).toMatchObject({ type: "error", error: { message: "Overloaded" } });
    // The classifier reads it as a failure, not as a clean end.
    expect(classifyStreamEvent("claude", "error", parsed[0])).toEqual({
      outcome: ROUTING_OUTCOMES.FAILED,
      terminalReason: TERMINAL_REASONS.UPSTREAM_ERROR,
    });
  });

  it("carries executor stream-error accessors across the rebuild", async () => {
    const getStreamError = () => ({ upstreamError: { body: "x" }, status: 500 });
    const source = upstream(JSON.stringify(CLAUDE_MESSAGE));
    source.__smGetStreamError = getStreamError;

    const response = await wholeReplyAsStream(source, "claude");
    expect(response.__smGetStreamError).toBe(getStreamError);
  });

  it("returns null for a response with no readable body", async () => {
    expect(await wholeReplyAsStream({ headers: new Headers(), body: null }, "claude")).toBeNull();
  });
});

describe("through the real handler", () => {
  /** Run a streamed /v1/messages turn through the production handler. */
  function runClaudeStream() {
    const body = { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true };
    return handleChatCore({
      body,
      modelInfo: { provider: "claude", model: "claude-opus-5-5" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() },
      connectionId: "conn-1",
      rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
      sourceFormatOverride: "claude",
      clientRawRequest: {
        endpoint: "/v1/messages", body,
        headers: { accept: "text/event-stream", "user-agent": "claude-cli/2.1.0" },
      },
    });
  }

  it("serves a whole reply the provider gave instead of a stream", async () => {
    // Exactly the production shape: HTTP 200, JSON content type, one whole
    // Message, no SSE framing.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(CLAUDE_MESSAGE), {
      status: 200, headers: { "content-type": "application/json" },
    }));

    const res = await runClaudeStream();
    expect(res.success).toBe(true);
    const text = await res.response.text();
    const parsed = payloads(text);

    expect(parsed.map((p) => p.type)).toContain("message_start");
    expect(parsed.map((p) => p.type)).toContain("message_stop");
    expect(parsed.find((p) => p.delta?.type === "text_delta")?.delta.text).toBe("Hello there");
  });

  it("still relays a real stream unchanged", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"live"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    fetchMock.mockResolvedValue(new Response(sse, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }));

    const res = await runClaudeStream();
    const text = await res.response.text();

    expect(text).toContain("live");
    // Exactly one terminal event: the reply was relayed, not re-framed or
    // doubled (`message_stop` also appears in the `event:` line, so count the
    // data payloads only).
    expect(payloads(text).filter((p) => p.type === "message_stop")).toHaveLength(1);
  });
});

describe("wholeReplyToSSE dispatch", () => {
  it("routes a Claude message and an OpenAI completion to their own shapes", () => {
    expect(wholeReplyToSSE(CLAUDE_MESSAGE, "claude")).toContain("message_start");
    expect(wholeReplyToSSE({ choices: [{ index: 0, message: { content: "x" }, finish_reason: "stop" }] }, "openai"))
      .toContain("[DONE]");
  });

  it("returns null for an empty or unrecognized body", () => {
    expect(wholeReplyToSSE(null, "claude")).toBeNull();
    expect(wholeReplyToSSE([], "claude")).toBeNull();
    expect(wholeReplyToSSE({ foo: 1 }, "claude")).toBeNull();
  });
});
