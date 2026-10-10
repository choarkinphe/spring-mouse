import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestSizeShape } from "../../open-sse/utils/requestSizeDiagnostics.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), mouse: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/mouse/tunnel.js", () => ({ dispatchMouseTask: mocks.mouse }));
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const id = "12345678-abcd-4321-abcd-123456789abc";
const records = (log) => log.errorLine.mock.calls.map((args) => JSON.parse(args[2].split("REQUEST-SIZE | ")[1]));
beforeEach(() => vi.clearAllMocks());

describe("outbound request size diagnostics", () => {
  it("measures UTF-8 bytes, not UTF-16 characters, without mutating content", () => {
    const body = { instructions: "指令🙂", input: [{ role: "user", content: [{ type: "input_text", text: "秘密内容" }, { type: "input_image", image_url: "data:image/png;base64,abc" }] }], tools: [{ name: "private" }] };
    const serialized = JSON.stringify(body);
    const shape = requestSizeShape(serialized, body);
    expect(shape.requestBytes).toBe(Buffer.byteLength(serialized, "utf8"));
    expect(shape.requestBytes).toBeGreaterThan(shape.requestChars);
    expect(shape).toMatchObject({ inputItems: 1, tools: 1, images: 1, instructionsChars: 4 });
    expect(JSON.stringify(shape)).not.toMatch(/秘密|指令|private|base64/);
    expect(JSON.stringify(body)).toBe(serialized);
  });

  it("logs the exact transformed bytes sent and associates response 507", async () => {
    const executor = new BaseExecutor("codex", { baseUrl: "https://upstream.invalid", retry: { 507: { attempts: 0 } } });
    executor.transformRequest = (_model, body) => ({ ...body, instructions: "private 指令" });
    mocks.fetch.mockResolvedValue(new Response("buffer limit", { status: 507 }));
    const log = { errorLine: vi.fn() };
    const result = await executor.execute({ model: "secret-model", body: { input: "秘密" }, stream: true, credentials: { apiKey: "secret-key", connectionId: "private-account" }, requestId: id, log });
    expect(result.response.status).toBe(507);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const sent = mocks.fetch.mock.calls[0][1].body;
    const rec = records(log);
    expect(rec[0]).toMatchObject({ phase: "send", requestId: id, requestBytes: Buffer.byteLength(sent), retry: 0 });
    expect(rec[1]).toMatchObject({ phase: "response_headers", status: 507, requestBytes: rec[0].requestBytes, sendId: rec[0].sendId });
    expect(JSON.stringify(rec)).not.toMatch(/secret|private|秘密|指令/);
  });

  it("keeps per-send identity and retry numbers without changing retry behavior", async () => {
    const executor = new BaseExecutor("codex", { baseUrl: "https://upstream.invalid", retry: { 503: { attempts: 1, delayMs: 0 } } });
    mocks.fetch.mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(new Response("ok"));
    const log = { errorLine: vi.fn() };
    expect((await executor.execute({ model: "m", body: {}, stream: false, credentials: {}, requestId: id, log })).response.status).toBe(200);
    const sends = records(log).filter((r) => r.phase === "send");
    expect(sends.map((r) => r.retry)).toEqual([0, 1]);
    expect(sends[0].sendId).not.toBe(sends[1].sendId);
  });

  it("is fail-open when logging throws and emits nothing for other providers", async () => {
    mocks.fetch.mockResolvedValue(new Response("ok"));
    const executor = new BaseExecutor("codex", { baseUrl: "https://upstream.invalid" });
    await expect(executor.execute({ model: "m", body: {}, stream: false, credentials: {}, log: { errorLine() { throw new Error("bad logger"); } } })).resolves.toBeDefined();
    const log = { errorLine: vi.fn() };
    await new BaseExecutor("other", { baseUrl: "https://upstream.invalid" }).execute({ model: "m", body: {}, stream: false, credentials: {}, log });
    expect(log.errorLine).not.toHaveBeenCalled();
  });

  it("records Mouse dispatch size without retaining task credentials", async () => {
    mocks.mouse.mockResolvedValue({ status: 200, headers: {}, body: "ok" });
    const log = { errorLine: vi.fn() };
    const executor = new BaseExecutor("codex", { baseUrl: "https://upstream.invalid" });
    await executor.execute({ model: "m", body: { input: "图片🙂" }, stream: false, credentials: { apiKey: "secret", mouseExecution: { mouseId: "mouse" } }, requestId: id, log });
    const sent = mocks.mouse.mock.calls[0][1].request.body;
    expect(records(log)[0]).toMatchObject({ transport: "mouse", requestBytes: Buffer.byteLength(sent) });
    expect(records(log)[1].status).toBe(200);
  });
});
