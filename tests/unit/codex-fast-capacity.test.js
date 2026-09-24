import { describe, expect, it } from "vitest";
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
});

