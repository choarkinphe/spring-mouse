import { describe, it, expect } from "vitest";
import { __test__ } from "../../open-sse/executors/qoder.js";

const { wrapQoderSSE, isBillingBlock } = __test__;
const frame = (statusCodeValue, body) => `data: ${JSON.stringify({ statusCodeValue, body: typeof body === "string" ? body : JSON.stringify(body) })}\n\n`;
const output = frame(200, { choices: [{ delta: { content: "hello" } }] });
const queue = frame(403, { code: 10605, message: "Queue limit", retry_after: 17 });
function response(chunks, onCancel) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { for (const chunk of chunks) c.enqueue(encoder.encode(chunk)); if (!onCancel) c.close(); },
    cancel: onCancel,
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("Qoder SSE errors", () => {
  it("recognizes numeric and string billing codes", () => {
    expect(isBillingBlock('{"code":10605}')).toBe(true);
    expect(isBillingBlock('{"code":"112"}')).toBe(true);
    expect(isBillingBlock('{"pricingUrl":"x"}')).toBe(true);
    expect(isBillingBlock('{"code":500}')).toBe(false);
  });
  it("scans heartbeats and split frames and preserves HTTP evidence and retry", async () => {
    let cancelled = false;
    const input = `: ping\n\n${frame(200, { choices: [{ delta: { role: "assistant" } }] })}${queue}`;
    const result = await wrapQoderSSE(response([input.slice(0, 19), input.slice(19, 70), input.slice(70)], () => { cancelled = true; }), "qoder/auto");
    expect(result.status).toBe(429);
    expect((await result.json()).error.code).toBe(10605);
    expect(result.__smUpstreamError).toMatchObject({ source: "sse", status: 200, retryAfterMs: 17000 });
    expect(cancelled).toBe(true);
  });
  it("returns other pre-output errors for fallback", async () => {
    const result = await wrapQoderSSE(response([frame(500, "broken")]), "qoder/auto");
    expect(result.status).toBe(500);
    expect(result.__smUpstreamError.status).toBe(200);
  });
  it("exposes a structured post-output failure without success sentinel", async () => {
    const result = await wrapQoderSSE(response([output, queue]), "qoder/auto");
    expect(result.status).toBe(200);
    expect(result.__smGetStreamError()).toBeNull();
    const text = await result.text();
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"code":10605');
    expect(text).not.toContain('finish_reason');
    expect(text).not.toContain('[DONE]');
    expect(result.__smGetStreamError()).toMatchObject({ status: 429, upstreamError: { status: 200, retryAfterMs: 17000 } });
  });
  it("keeps successful completion and cancels upstream", async () => {
    let cancelled = false;
    const result = await wrapQoderSSE(response([output + frame(200, "[DONE]")], () => { cancelled = true; }), "qoder/auto");
    expect(await result.text()).toContain('data: [DONE]');
    expect(cancelled).toBe(true);
  });
  it("propagates cancellation while waiting for first output", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const promise = wrapQoderSSE(response([": ping\n\n"], () => { cancelled = true; }), "qoder/auto", { signal: controller.signal, deadlineMs: Date.now() + 10000 });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
  it("converts a stream exception after output to structured failure", async () => {
    const encoder = new TextEncoder();
    let count = 0;
    const upstream = new Response(new ReadableStream({ pull(c) { if (!count++) c.enqueue(encoder.encode(output)); else c.error(new Error("socket failure")); } }, { highWaterMark: 0 }));
    const result = await wrapQoderSSE(upstream, "qoder/auto");
    const text = await result.text();
    expect(text).toContain("socket failure");
    expect(text).not.toContain("[DONE]");
    expect(result.__smGetStreamError()).toMatchObject({ status: 502, upstreamError: { status: 200 } });
  });
  it("bounds a preamble with no model output", async () => {
    const result = await wrapQoderSSE(response([Array(6000).fill(`: ${"x".repeat(100)}\n\n`).join("")]), "qoder/auto");
    expect(result.status).toBe(503);
  });
  it("times out when only heartbeats arrive", async () => {
    let cancelled = false;
    const result = await wrapQoderSSE(response([": ping\n\n"], () => { cancelled = true; }), "qoder/auto", { deadlineMs: Date.now() + 30 });
    expect(result.status).toBe(503);
    expect(cancelled).toBe(true);
  });
});
