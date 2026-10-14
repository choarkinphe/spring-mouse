// Locks BaseExecutor.execute retry/fallback behavior (docs 04 GAP #1, docs 11 §7).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network layer so we can script upstream responses.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

function makeExec(config) {
  const ex = new BaseExecutor("test", config);
  // make headers trivial; credentials empty
  return ex;
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("BaseExecutor.execute — retry by status (config-driven)", () => {
  it("retries 502 `attempts` times then succeeds", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after exhausting 502 attempts on a single url and throws", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 2, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(502));
    // single url: 1 initial + 2 retries = 3 calls, then returns the 502 response (no fallback url)
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("BaseExecutor.execute — baseUrls fallback", () => {
  it("falls over to the next url on 429 (shouldRetry)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 429: { attempts: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(429)) // url[0] → fallback
      .mockResolvedValueOnce(res(200)); // url[1] ok
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("BaseExecutor.execute — network error retry/fallback", () => {
  it("maps network exception to 502 retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock
      .mockImplementationOnce(async () => { throw new Error("ECONNRESET"); })
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the only url fails with network error and no retries left", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0 } } });
    // mockImplementationOnce (not persistent) avoids vitest flagging a reused rejection.
    fetchMock.mockImplementationOnce(async () => { throw new Error("boom"); });
    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.message).toBe("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — cancellation during retry backoff", () => {
  it("cancels the abandoned body and aborts its fetch before sleeping", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 1000 } } });
    const client = new AbortController();
    const cancel = vi.fn();
    let fetchSignal;
    fetchMock.mockImplementationOnce(async (_url, options) => {
      fetchSignal = options.signal;
      return new Response(new ReadableStream({ cancel }), { status: 502 });
    });
    const pending = ex.execute({ model: "m", body: {}, stream: true, credentials: creds, signal: client.signal });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetchSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.abort("client disconnected");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases a fallback response without consuming the successful one", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 429: { attempts: 0 } } });
    const cancel = vi.fn();
    const finalCancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 429 }));
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: finalCancel }), { status: 200 }));
    const result = await ex.execute({ model: "m", body: {}, stream: true, credentials: creds });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
    expect(finalCancel).not.toHaveBeenCalled();
    await result.response.body.cancel();
  });

  it("preserves an error response when the provider vetoes retry", async () => {
    const ex = makeExec({ baseUrl: "https://a/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn(async () => false);
    fetchMock.mockResolvedValueOnce(new Response("useful upstream error", { status: 503 }));
    const result = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(await result.response.text()).toBe("useful upstream error");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  });
  it("stops retrying immediately when the client disconnects during backoff", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 1000 } } });
    const client = new AbortController();
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));

    const pending = ex.execute({ model: "m", body: {}, stream: false, credentials: creds, signal: client.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const abortStartedAt = Date.now();
    client.abort("client disconnected");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - abortStartedAt).toBeLessThan(250);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — computeRetryDelay hook veto", () => {
  it("only invokes computeRetryDelay when status has retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(0);
    fetchMock.mockResolvedValueOnce(res(500));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(500);
    expect(ex.computeRetryDelay).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hook returning false skips retry (uses fallback path)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 429: { attempts: 5, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(res(429));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    // hook vetoes retry → no fallback url → returns the 429 response as-is
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
