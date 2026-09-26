/**
 * A Codex account can accept a request, emit its metadata frames, and then go
 * silent forever. Measured on production, 34 turns in one day ended that way:
 * each read nothing more until the 360s hard ceiling fired, with prompt_tokens=0
 * and completion_tokens=0 — no output ever arrived. The client in front of this
 * gateway gives up at ~180s, so the caller saw a silent hang while the gateway
 * was still waiting on a stream that had already stopped.
 *
 * These pin the idle watchdog that closes that gap. It lives on the
 * forced-streaming read path (a non-streaming client behind a forceStream
 * provider), which is the path those turns actually took — NOT the streaming
 * pipe, whose own stall timer never ran for them.
 */
import { describe, expect, it, vi } from "vitest";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const CLIENT_IDLE_TIMEOUT_MS = 180_000;

/** A stream that emits `prefix` then never sends anything again. */
function stallingStream(prefix) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(prefix)); },
    // Never resolves: the upstream accepted the request and went quiet.
    pull() { return new Promise(() => {}); },
  });
}

function ctx(body, { stallTimeoutMs, aborts } = {}) {
  return {
    providerResponse: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "gpt-6-astra",
    body: { model: "gpt-6-astra", input: "hi" },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    clientRawRequest: { endpoint: "/v1/messages" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    log: {},
    streamController: { signal: undefined, abort: (r) => aborts?.push(r) },
    providerStrategy: stallTimeoutMs ? { stallTimeoutMs } : null,
  };
}

const METADATA_FRAMES = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
  "",
  "",
].join("\n");

describe("forced-streaming idle watchdog", () => {
  it("cuts off a stream that goes silent, as a 503 the caller can retry", async () => {
    const aborts = [];
    const result = await handleForcedSSEToJson(ctx(stallingStream(METADATA_FRAMES), { stallTimeoutMs: 300, aborts }));

    expect(result.success).toBe(false);
    // 503, not 502/504: a model that went quiet mid-turn is a transient upstream
    // capacity problem, which is what the caller's rotation logic acts on.
    expect(result.status).toBe(503);
    expect(result.upstreamError?.layer).toBe("provider");
    expect(result.upstreamError?.source).toBe("sse");
    // The upstream fetch is actually released, not merely abandoned.
    expect(aborts).toContain("upstream_idle_timeout");
  }, 15000);

  it("does not cut off a turn that keeps producing output", async () => {
    const encoder = new TextEncoder();
    const frames = [];
    for (let i = 0; i < 6; i++) {
      frames.push(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"chunk${i}"}\n\n`);
    }
    frames.push('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":6,"total_tokens":9}}}\n\n');

    let i = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        if (i >= frames.length) { controller.close(); return; }
        // Each chunk arrives well inside the idle bound.
        await new Promise((r) => setTimeout(r, 40));
        controller.enqueue(encoder.encode(frames[i++]));
      },
    });

    const result = await handleForcedSSEToJson(ctx(stream, { stallTimeoutMs: 300 }));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
  }, 15000);

  it("reads the bound from the channel strategy, above the provider default", () => {
    // The registry default is the 170s chosen from the production distribution.
    expect(PROVIDERS.codex.stallTimeoutMs).toBe(170_000);
    // And it fires before the client gives up, so the caller learns the turn
    // failed instead of waiting out its own watchdog.
    expect(PROVIDERS.codex.stallTimeoutMs).toBeLessThan(CLIENT_IDLE_TIMEOUT_MS);
  });
});
