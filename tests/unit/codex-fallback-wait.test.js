import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const encoder = new TextEncoder();
const frame = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const overload = frame("error", { error: { code: "server_is_overloaded", message: "Our servers are currently overloaded" } });
const completed = frame("response.completed", { response: { status: "completed" } });
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const args = () => ({ model: "gpt-6-astra", stream: true, body: { input: "synthetic probe" }, credentials: { accessToken: "synthetic" } });
const log = { info() {}, warn() {}, debug() {} };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fetchMock.mockReset(); });

describe("Codex fallback waiting policy", () => {
  it("hands SSE overload to a configured same-model backup without sleeping or reuploading", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(sse(overload)).mockResolvedValueOnce(sse(completed));
    const started = Date.now(), deadlineMs = started + 150000;
    const attempts = [];
    const result = await handleComboChat({
      body: args().body, models: ["primary/gpt-6-astra", "backup/gpt-6-astra"],
      comboName: "synthetic", comboStrategy: "fallback", autoSwitch: false, deadlineMs, log,
      handleSingleModel: async (_body, model, options) => {
        attempts.push([model, options.hasFallback]);
        return (await new CodexExecutor().execute({ ...args(), ...options, overloadDeadline: deadlineMs })).response;
      },
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(completed);
    expect(attempts).toEqual([["primary/gpt-6-astra", true], ["backup/gpt-6-astra", false]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(started);
  });

  it("retains single-route overload recovery", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(sse(overload)).mockResolvedValueOnce(sse(completed));
    const work = new CodexExecutor().execute(args());
    await vi.advanceTimersByTimeAsync(4000);
    const result = await work;
    expect(result.response.status).toBe(200);
    expect(result.timing.upstreamAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["headers", "preamble"])("reserves half a late candidate's remaining 40 seconds during %s", async phase => {
    vi.useFakeTimers();
    const cancel = vi.fn(); let networkSignal;
    fetchMock.mockImplementation(async (_url, options) => {
      networkSignal = options.signal;
      if (phase === "headers") return new Promise(() => {});
      return new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(frame("response.created"))); }, cancel,
      }), { headers: { "content-type": "text/event-stream" } });
    });
    let finished = false;
    const work = new CodexExecutor().execute({ ...args(), hasFallback: true, overloadDeadline: Date.now() + 40000 })
      .then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(19999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await work;
    expect(result.response.status).toBe(503);
    expect(result.response.__smUpstreamError).toMatchObject({ origin: "sse_first_output_timeout", layer: "gateway" });
    expect(fetchMock).toHaveBeenCalledOnce();
    if (phase === "headers") expect(networkSignal.aborted).toBe(true);
    else expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds header wait by the executor budget even without a combo", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, overloadRetry: { budgetMs: 1000 } };
    const work = executor.execute(args());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await work;
    expect(result.response.status).toBe(503);
    expect(result.response.__smUpstreamError).toMatchObject({ source: "dispatch", origin: "sse_first_output_timeout" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not truncate or replay accepted long output after the waiting deadline", async () => {
    vi.useFakeTimers();
    let controller, networkSignal;
    const cancel = vi.fn();
    const first = frame("response.output_text.delta", { delta: "x".repeat(220) });
    fetchMock.mockImplementation(async (_url, options) => {
      networkSignal = options.signal;
      return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(first)); }, cancel }),
        { headers: { "content-type": "text/event-stream" } });
    });
    const result = await new CodexExecutor().execute({ ...args(), hasFallback: true, overloadDeadline: Date.now() + 40000 });
    await vi.advanceTimersByTimeAsync(400000);
    expect(networkSignal.aborted).toBe(false);
    controller.enqueue(encoder.encode(completed)); controller.close();
    expect(await result.response.text()).toBe(first + completed);
    expect(cancel).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never dispatches an expired request even when a backup exists", async () => {
    const result = await new CodexExecutor().execute({ ...args(), hasFallback: true, overloadDeadline: Date.now() - 1 });
    expect(result.response.status).toBe(503);
    expect(result.response.__smUpstreamError.origin).toBe("sse_first_output_timeout");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves client cancellation during header wait", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const work = new CodexExecutor().execute({ ...args(), signal: controller.signal, hasFallback: true,
      overloadDeadline: Date.now() + 40000 });
    const assertion = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
