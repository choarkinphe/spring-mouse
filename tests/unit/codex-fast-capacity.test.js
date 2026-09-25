import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("classifies the provider's overloaded-server SSE error for account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Our servers are currently overloaded. Please try again later."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("our servers are currently overloaded");
    expect(peek.accountFallback).toBe(false);
    expect(peek.message).toBe("Our servers are currently overloaded. Please try again later.");
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});

it("keeps the original SSE evidence when upstream returns an overloaded error", async () => {
  const executor = new CodexExecutor();
  const response = new Response(streamFromText([
    "event: error",
    'data: {"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}',
    "",
  ].join("\n")), { status: 200, headers: { "Content-Type": "text/event-stream" } });

  const peek = await executor._peekSseTransientError(response);
  expect(peek.upstreamError).toMatchObject({
    source: "sse",
    status: 200,
    message: "Our servers are currently overloaded. Please try again later.",
  });
  expect(peek.upstreamError.body).toContain("server_is_overloaded");
});

// Codex can stream a few output deltas and only THEN fail the turn with a capacity
// error. The peek used to stop at the first delta, so that 200-OK error stream was
// handed back as a success: the combo accepted it and never rotated to the next
// model, and the client saw "Our servers are currently overloaded" instead of a
// fallback. These pin the bounded post-output grace scan that fixes it.
describe("Codex detects a capacity error that arrives after output has started", () => {
  const delta = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"Sure"}',
    "",
  ].join("\n");
  const overload = [
    "event: error",
    'data: {"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}',
    "",
  ].join("\n");

  it("still matches the overload after an output delta in the same chunk", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText(delta + overload), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("server_is_overloaded");
    expect(peek.accountFallback).toBe(false);
  });

  it("still matches the overload when the delta and error arrive in separate chunks", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(delta));
        controller.enqueue(encoder.encode(overload));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("server_is_overloaded");
  });

  it("does not wait for the grace window on a normal completed turn", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"r1"}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const startedAt = Date.now();
    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    // A terminal frame ends the scan immediately — no full grace-window stall.
    expect(Date.now() - startedAt).toBeLessThan(120);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("reassembles the stream byte-for-byte when only output is present", async () => {
    const executor = new CodexExecutor();
    const text = delta;
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  // The model's own output travels as SSE data too. A reply that merely QUOTES the
  // overload sentence must not be read as an upstream failure — otherwise asking
  // "why did I get 'our servers are currently overloaded'?" would itself fail over.
  it("does not treat an overload sentence quoted in the reply as a failure", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"The error text is: Our servers are currently overloaded. Please try again later."}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("matches an error frame even when it is split across chunks", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: error\ndata: {\"error\":{\"code\":\"server_is_"));
        controller.enqueue(encoder.encode("overloaded\",\"message\":\"Our servers are currently overloaded. Please try again later.\"}}\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("server_is_overloaded");
  });

  // Regression: an overload frame that arrives AFTER the turn has started emitting
  // output. The scan used to stop after a fixed 150ms, which is shorter than the gap
  // observed in production (a couple of deltas, then the rejection), so the frame was
  // passed to the client as a normal 200-OK stream — recorded as success, no retry.
  // The window is now content-aware: a short burst of output keeps the scan alive.
  it("catches an overload frame that arrives after output has started", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const response = new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n'));
        await sleep(300); // well past the old fixed 150ms window
        controller.enqueue(encoder.encode(
          'event: error\ndata: {"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("server_is_overloaded");
  }, 10000);

  // The content-aware window must not hold a healthy stream open: once the turn has
  // produced substantial output the scan ends immediately, without waiting out the
  // hard time ceiling.
  it("releases a healthy stream as soon as it has produced enough output", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${"x".repeat(400)}"}\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const startedAt = Date.now();
    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    // Far below the 2000ms ceiling: the char threshold ended the scan at once.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  // Regression (production, 2026-09-25): Codex's `response.created` frame replays the
  // whole `tools` schema, so a single frame can exceed 170KB. Two of them pushed the
  // overload frame to byte 354251 — past the old fixed 256KB scan ceiling — so the
  // scan stopped before ever seeing it, and the error was translated into an ordinary
  // text delta shown to the client as the model's reply. The ceiling is now
  // byte-based and far larger during the metadata preamble.
  it("catches an overload frame that sits behind multi-hundred-KB metadata frames", async () => {
    const executor = new CodexExecutor();
    const bigFrame = (name, bytes) =>
      `event: ${name}\ndata: {"type":"${name}","response":{"id":"resp_1","tools":[{"name":"${"x".repeat(Math.max(0, bytes - 200))}"}]}}\n\n`;
    const overload = 'event: error\ndata: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","headers":{"x-retry-metadata":"NO_MORE_RETRY"},"message":"Our servers are currently overloaded. Please try again later."},"sequence_number":2}\n\n';
    const text = bigFrame("response.created", 177000) + bigFrame("response.in_progress", 177000) + overload;

    const response = new Response(streamFromText(text), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("server_is_overloaded");
    expect(peek.accountFallback).toBe(false);
  });

  // The larger preamble ceiling must not delay a healthy stream: once a content frame
  // appears the content-aware rules take over and release it immediately.
  it("still releases a healthy stream promptly behind large metadata frames", async () => {
    const executor = new CodexExecutor();
    const bigFrame = (name, bytes) =>
      `event: ${name}\ndata: {"type":"${name}","response":{"id":"resp_1","tools":[{"name":"${"x".repeat(Math.max(0, bytes - 200))}"}]}}\n\n`;
    const text = bigFrame("response.created", 177000)
      + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed"}\n\n';

    const response = new Response(streamFromText(text), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const startedAt = Date.now();
    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

// The byte ceiling is a STRUCTURAL escape boundary, not just a memory guard. When
// it is hit before any output, the scan has seen neither content nor an error, so
// it cannot tell an overloaded stream from a healthy one. Returning matched:null
// with no unresolved flag made the caller forward that unresolved stream — the
// exact escape class the 256KB->2MB raise was meant to close, reintroduced at the
// new ceiling. These pin that a pre-output ceiling hit is reported as UNRESOLVED.
describe("Codex preamble ceiling is an unresolved stop, not a silent pass-through", () => {
  // CODEX_SSE_PEEK_BYTES is resolved at module load, so override the env and
  // re-import to exercise a small ceiling without building a 2MB fixture.
  async function withPeekBytes(bytes, fn) {
    const prev = process.env.SPRING_MOUSE_CODEX_SSE_PEEK_BYTES;
    process.env.SPRING_MOUSE_CODEX_SSE_PEEK_BYTES = String(bytes);
    vi.resetModules();
    try {
      const mod = await import("../../open-sse/executors/codex.js");
      return await fn(new mod.CodexExecutor());
    } finally {
      if (prev === undefined) delete process.env.SPRING_MOUSE_CODEX_SSE_PEEK_BYTES;
      else process.env.SPRING_MOUSE_CODEX_SSE_PEEK_BYTES = prev;
      vi.resetModules();
    }
  }

  const OVERLOAD = 'event: error\ndata: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}\n\n';

  it("flags stoppedOnCeiling when the preamble overruns the ceiling before any output", async () => {
    await withPeekBytes(4096, async (executor) => {
      // The preamble must arrive in its OWN chunk(s): the ceiling is checked at the
      // top of the read loop, so a single chunk carrying both preamble and error
      // would be scanned whole and the error caught (correct, but not the case under
      // test). Splitting mirrors the real upstream, which streams the metadata frames
      // first and only then — on an overload — emits the error frame.
      const encoder = new TextEncoder();
      const preamble = `event: response.created\ndata: {"type":"response.created","response":{"tools":[{"name":"${"x".repeat(12000)}"}]}}\n\n`;
      const response = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(preamble));   // 12KB, over the 4KB ceiling
          controller.enqueue(encoder.encode(OVERLOAD));   // error frame arrives after
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

      const peek = await executor._peekSseTransientError(response);
      expect(peek.matched).toBeNull();
      // The flag the caller keys on. Without it this stream would be forwarded.
      expect(peek.stoppedOnDeadline).toBe(true);
      expect(peek.stoppedOnCeiling).toBe(true);
      expect(peek.replacementBody).toBeNull();
      expect(peek.upstreamError.message).toContain("ceiling");
    });
  });

  it("does NOT flag a ceiling stop once output has begun (healthy release)", async () => {
    await withPeekBytes(4096, async (executor) => {
      const text = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n'
        + `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${"y".repeat(12000)}"}\n\n`;
      const response = new Response(streamFromText(text), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const peek = await executor._peekSseTransientError(response);
      expect(peek.matched).toBeNull();
      // Output was flowing: this is a normal healthy release, and the caller must
      // hand the (reassembled) stream to the client.
      expect(peek.stoppedOnDeadline).toBe(false);
      expect(peek.replacementBody).not.toBeNull();
    });
  });

  it("still catches an overload frame that sits inside the ceiling", async () => {
    await withPeekBytes(65536, async (executor) => {
      const preamble = `event: response.created\ndata: {"type":"response.created","response":{"tools":[{"name":"${"x".repeat(12000)}"}]}}\n\n`;
      const response = new Response(streamFromText(preamble + OVERLOAD), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const peek = await executor._peekSseTransientError(response);
      expect(peek.matched).toBe("server_is_overloaded");
      expect(peek.stoppedOnCeiling).toBeFalsy();
    });
  });
});

