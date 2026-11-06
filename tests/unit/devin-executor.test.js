import { beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(), appendRequestLog: vi.fn().mockResolvedValue(undefined), saveRequestDetail: vi.fn().mockResolvedValue(undefined), saveRequestUsage: vi.fn().mockResolvedValue(undefined) }));
import { DevinExecutor, getDevinSessionToken } from "../../open-sse/executors/devin.js";
import { DEVIN } from "../../open-sse/config/devin.js";
import { decodeProtobuf, encodeBytesField as b, encodeVarintField as v } from "../../open-sse/shared/devin/protobuf.js";
import { wrapConnectEnvelope as frame } from "../../open-sse/shared/devin/protocol.js";

const concat = (...bytes) => Buffer.concat(bytes);
const eos = () => frame(Buffer.from("{}"), 2);
const success = () => new Response(concat(frame(concat(b(3, "hello"), v(5, 2))), frame(b(7, concat(v(2, 10), v(3, 5)))), eos()), { headers: { "content-type": "application/connect+proto", "content-length": "999", "x-request-id": "fake-upstream" } });
const opts = extra => ({ model: "swe-2-high", body: { messages: [{ role: "user", content: "hi" }] }, credentials: { apiKey: "fake-token" }, ...extra });
const field = (bytes, number) => decodeProtobuf(bytes).find(f => f.number === number)?.value;
const sse = text => text.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).filter(s => s !== "[DONE]").map(JSON.parse);

beforeEach(() => { fetchMock.mockReset(); });

describe("Devin executor", () => {
  it("normalizes native session token format without double-prefixing", () => {
    expect(getDevinSessionToken({ accessToken: " eyJ.test " })).toBe("devin-session-token$eyJ.test");
    expect(getDevinSessionToken({ apiKey: "devin-session-token$eyJ.test" })).toBe("devin-session-token$eyJ.test");
    expect(getDevinSessionToken({ providerSpecificData: { session_token: "opaque" } })).toBe("opaque");
  });
  it("uses proxy-aware binary POST, correct headers, abort signal and result contract", async () => {
    fetchMock.mockResolvedValue(success());
    const executor = new DevinExecutor();
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid" };
    const result = await executor.execute(opts({ proxyOptions, credentials: { accessToken: "eyJ.test" } }));
    expect(result.url).toBe(`${DEVIN.baseUrl}${DEVIN.chatPath}`);
    const [url, init, proxy] = fetchMock.mock.calls[0];
    expect(url).toBe(result.url);
    expect(proxy).toBe(proxyOptions);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe("Basic devin-session-token$eyJ.test");
    expect(init.headers["Content-Type"]).toBe("application/connect+proto");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Buffer.isBuffer(result.transformedBody)).toBe(false);
    expect(field(field(init.body.subarray(5), 1), 3).toString()).toBe("devin-session-token$eyJ.test");
    expect(result.transformedBody).toMatchObject({ protocol: "application/connect+proto", model: "swe-2-high", promptCount: 1, toolCount: 0, wireBytes: init.body.length - 5 });
    const loggedRequest = JSON.stringify({ headers: result.headers, body: result.transformedBody });
    expect(loggedRequest).not.toContain("eyJ.test");
    expect(loggedRequest).not.toContain("devin-session-token$");
    expect(result.headers.Authorization).toBe("[REDACTED]");
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    expect(result.response.headers.has("content-length")).toBe(false);
    expect(result.response.headers.get("x-request-id")).toBe("fake-upstream");
    const text = await result.response.text();
    expect(sse(text).find(c => c.choices[0]?.delta.content)?.choices[0].delta.content).toBe("hello");
    expect(text).not.toContain("[DONE]"); // Added once by the shared SSE flush.
    expect(sse(text).at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
  it("gzips requests above 8KiB and sets only the request compression header", async () => {
    fetchMock.mockResolvedValue(success());
    const result = await new DevinExecutor().execute(opts({ body: { messages: [{ role: "user", content: "x".repeat(9000) }] } }));
    const init = fetchMock.mock.calls[0][1];
    expect(init.body[0]).toBe(1);
    expect(init.headers["Connect-Content-Encoding"]).toBe("gzip");
    expect(init.headers["Connect-Accept-Encoding"]).toBeUndefined();
    const wire = gunzipSync(init.body.subarray(5));
    expect(field(wire, 21).toString()).toBe("swe-2-high");
    expect(result.transformedBody.wireBytes).toBe(wire.length);
    await result.response.text();
  });
  it("rejects metadata/usage-only empty replies before returning HTTP success", async () => {
    fetchMock.mockResolvedValue(new Response(concat(frame(b(1, "output-id")), frame(b(7, concat(v(2, 10), v(3, 5)))), eos())));
    const result = await new DevinExecutor().execute(opts());
    expect(result.response.status).toBe(502);
    expect(await result.response.json()).toMatchObject({ error: { code: "empty_stream" } });
  });
  it("preserves pre-content trailer error as native HTTP failure for fallback", async () => {
    fetchMock.mockResolvedValue(new Response(frame(Buffer.from('{"error":{"code":"resource_exhausted","message":"quota"}}'), 2)));
    const result = await new DevinExecutor().execute(opts());
    expect(result.response.status).toBe(429);
    expect(await result.response.json()).toMatchObject({ error: { code: "resource_exhausted" } });
  });
  it("ignores credential-controlled base URL and allows explicit test configuration", () => {
    const executor = new DevinExecutor();
    expect(executor.buildUrl("m", true, 0, { providerSpecificData: { baseUrl: "https://attacker.invalid" } })).toBe(`${DEVIN.baseUrl}${DEVIN.chatPath}`);
    expect(new DevinExecutor({ baseUrl: "http://localhost:1234" }).buildUrl()).toBe(`http://localhost:1234${DEVIN.chatPath}`);
  });
  it("produces one DONE and one authoritative usage event through the shared passthrough", async () => {
    const { createSSEStream } = await import("../../open-sse/utils/stream.js");
    fetchMock.mockResolvedValue(success());
    const result = await new DevinExecutor().execute(opts());
    const transform = createSSEStream({ mode: "passthrough", targetFormat: "openai", sourceFormat: "openai", provider: "devin", model: "swe-2-high", inputTokenEstimate: 999 });
    const text = await new Response(result.response.body.pipeThrough(transform)).text();
    expect((text.match(/data: \[DONE\]/g) || []).length).toBe(1);
    const withUsage = sse(text).filter(c => c.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toMatchObject({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
  it("keeps forced JSON aggregation correct without an upstream DONE marker", async () => {
    const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
    fetchMock.mockResolvedValue(success());
    const result = await new DevinExecutor().execute(opts());
    const completion = parseSSEToOpenAIResponse(await result.response.text(), "swe-2-high");
    expect(completion.choices[0]).toMatchObject({ finish_reason: "stop", message: { content: "hello" } });
    expect(completion.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
  it("aggregates non-stream JSON and usage using the same upstream protocol", async () => {
    fetchMock.mockResolvedValue(success());
    const result = await new DevinExecutor().execute(opts({ stream: false }));
    const json = await result.response.json();
    expect(result.response.headers.get("content-type")).toBe("application/json");
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0]).toEqual({ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" });
    expect(json.usage.total_tokens).toBe(15);
  });
  it("preserves native HTTP errors, status, body and headers", async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"expired"}', { status: 401, statusText: "Unauthorized", headers: { "content-type": "application/json", "retry-after": "3" } }));
    const result = await new DevinExecutor().execute(opts());
    expect(result.response.status).toBe(401);
    expect(result.response.statusText).toBe("Unauthorized");
    expect(result.response.headers.get("retry-after")).toBe("3");
    expect(await result.response.text()).toBe('{"error":"expired"}');
  });
  it.each([
    concat(frame(b(3, "partial")), frame(Buffer.from('{"error":{"code":"resource_exhausted","message":"quota"}}'), 2)),
    frame(concat(b(3, "partial"), v(5, 2))),
    concat(frame(b(3, "partial")), frame(Buffer.from("bad trailer"), 2)),
  ])("emits explicit SSE error, never success finish or DONE, on protocol failure", async wire => {
    fetchMock.mockResolvedValue(new Response(wire));
    const result = await new DevinExecutor().execute(opts());
    const text = await result.response.text();
    expect(text).not.toContain("[DONE]");
    const chunks = sse(text);
    expect(chunks.at(-1).error).toMatchObject({ type: "upstream_error" });
    expect(chunks.some(c => c.choices?.[0]?.finish_reason)).toBe(false);
  });
  it("exposes late trailer status and diagnostics through the shared error accessor", async () => {
    fetchMock.mockResolvedValue(new Response(concat(frame(b(3, "partial")), frame(Buffer.from('{"error":{"code":"resource_exhausted","message":"quota reached"}}'), 2))));
    const result = await new DevinExecutor().execute(opts());
    expect(result.response.__smGetStreamError()).toBeNull();
    await result.response.text();
    expect(result.response.__smGetStreamError()).toMatchObject({ status: 429, upstreamError: { status: 429, source: "sse", layer: "provider", message: expect.stringContaining("quota reached") } });
    expect(JSON.stringify(result.response.__smGetStreamError())).not.toContain("fake-token");
  });
  it("rejects truncated non-stream responses instead of returning partial output", async () => {
    fetchMock.mockResolvedValue(new Response(frame(b(3, "partial"))));
    await expect(new DevinExecutor().execute(opts({ stream: false }))).rejects.toMatchObject({ code: "stream_truncated" });
  });
  it("propagates upstream fetch failures", async () => {
    fetchMock.mockRejectedValue(new Error("network unavailable"));
    await expect(new DevinExecutor().execute(opts())).rejects.toThrow("network unavailable");
  });
  it("rejects unsupported features and missing credentials before fetch", async () => {
    const executor = new DevinExecutor();
    await expect(executor.execute(opts({ credentials: {} }))).rejects.toThrow(/token/);
    const invalid = await executor.execute(opts({ body: { messages: [{ role: "user", content: "hi" }], temperature: -1 } }));
    expect(invalid.response.status).toBe(400);
    expect(await invalid.response.json()).toMatchObject({ error: { type: "invalid_request_error", code: "invalid_request", message: expect.stringContaining("sampling") } });
    expect(invalid.headers).toEqual({});
    expect(invalid.transformedBody).not.toBeInstanceOf(Buffer);
    await expect(executor.execute(opts({ credentials: { apiKey: "x", mouseExecution: { mouseId: "x" } } }))).rejects.toThrow(/Mouse/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not fetch when already aborted or the dispatch budget has expired", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new DevinExecutor().execute(opts({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    await expect(new DevinExecutor().execute(opts({ overloadDeadline: Date.now() - 1 }))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("aborts a hanging fetch when connect timeout expires", async () => {
    let fetchSignal;
    fetchMock.mockImplementation((url, init) => {
      fetchSignal = init.signal;
      return new Promise(() => {}); // Transport deliberately ignores abort.
    });
    await expect(new DevinExecutor({ timeoutMs: 10 }).execute(opts())).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchSignal.aborted).toBe(true);
  });
  it("aborts a pending fetch on caller cancellation", async () => {
    let fetchSignal;
    fetchMock.mockImplementation((url, init) => {
      fetchSignal = init.signal;
      return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason || new Error("aborted")), { once: true }));
    });
    const controller = new AbortController();
    const result = new DevinExecutor().execute(opts({ signal: controller.signal }));
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal.aborted).toBe(true);
  });
  it("cancels original upstream reader when downstream cancels", async () => {
    let cancelled = false;
    const source = new ReadableStream({ start(c) { c.enqueue(frame(b(3, "hello"))); }, cancel() { cancelled = true; } });
    fetchMock.mockResolvedValue(new Response(source));
    const result = await new DevinExecutor().execute(opts());
    const reader = result.response.body.getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(cancelled).toBe(true);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("aborts a pending stream read after upstream headers", async () => {
    let cancelled = false;
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(frame(b(3, "hello"))); }, cancel() { cancelled = true; } })));
    const controller = new AbortController();
    const result = await new DevinExecutor().execute(opts({ signal: controller.signal }));
    const pending = result.response.text();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
  it("preserves native Claude blocks and cache marks through real chatCore translation and dispatch", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    fetchMock.mockResolvedValue(success());
    const nativeBody = { model: "claude-opus-5-5-high", stream: false, max_tokens: 512,
      system: [{ type: "text", text: "native-system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "native-user", cache_control: { type: "ephemeral" } }] }, { role: "assistant", content: [{ type: "thinking", thinking: "native-thought", signature: "native-sig" }, { type: "tool_use", id: "call_a", name: "lookup", input: {}, cache_control: { type: "ephemeral" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "result" }] }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    };
    const result = await handleChatCore({ body: nativeBody, modelInfo: { provider: "devin", model: "claude-opus-5-5-high" }, credentials: { accessToken: "synthetic" }, sourceFormatOverride: "claude", internalRequest: true, observabilityEnabled: false, requestLogFileDumpsEnabled: false });
    expect(result.success).toBe(true);
    const wire = fetchMock.mock.calls[0][1].body.subarray(5);
    const prompts = decodeProtobuf(wire).filter(f => f.number === 3).map(f => f.value);
    expect(prompts.some(p => field(p, 3)?.toString() === "native-system" && field(field(p, 8), 1) === 1n)).toBe(true);
    const assistant = prompts.find(p => field(p, 2) === 2n);
    expect(field(assistant, 11).toString()).toBe("native-thought");
    expect(field(assistant, 12).toString()).toBe("native-sig");
    expect(field(field(assistant, 8), 1)).toBe(1n);
    expect((await result.response.json()).content).toEqual([{ type: "text", text: "hello" }]);
  });
  it("uses specialized registry executor and honors forced upstream stream despite client JSON body", async () => {
    const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.js");
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(hasSpecializedExecutor("devin")).toBe(true);
    expect(getExecutor("devin")).toBeInstanceOf(DevinExecutor);
    expect(PROVIDERS.devin.format).toBe("openai");
    expect(PROVIDERS.devin.forceStream).toBe(true);
    fetchMock.mockResolvedValue(success());
    const result = await getExecutor("devin").execute(opts({ stream: true, body: { stream: false, messages: [{ role: "user", content: "hello" }] } }));
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    const chunks = sse(await result.response.text());
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }], usage: { total_tokens: 15 } });
  });
});
