import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { createErrorResult, parseUpstreamError } from "../../open-sse/utils/error.js";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "fixture-only", isActive: true }]) }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "fixture-machine") }));
import { pingModelByKind } from "../../src/app/api/models/test/ping.js";

const executor = new OpenCodeExecutor();
const message = "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";
const payload = { type: "error", error: { type: "FreeTierError", message } };
afterEach(() => vi.unstubAllGlobals());

describe("OpenCode Free restriction errors", () => {
  it.each([payload, { type: "FreeTierError", message }])("explains a structured 403 and preserves upstream evidence", async (body) => {
    const raw = JSON.stringify(body);
    const parsed = await parseUpstreamError(new Response(raw, { status: 403 }), executor);
    expect(parsed.statusCode).toBe(403);
    expect(parsed.message).toContain("上游限制免费层仅供 OpenCode 客户端使用");
    expect(parsed.message).toContain("模型目录同步成功不代表拥有调用权限");
    expect(parsed.message).toContain("FreeTierError");
    expect(parsed.message).toContain(message);
    expect(parsed.upstreamError).toMatchObject({ status: 403, body: raw });
    const result = createErrorResult(parsed.statusCode, parsed.message, undefined, parsed.upstreamError);
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).error.message).toBe(parsed.message);
  });

  it.each([
    [403, JSON.stringify({ error: { type: "permission_error", message: "Access denied" } })],
    [403, JSON.stringify({ error: { type: "quota_exceeded", message: "FreeTierError mentioned in a message" } })],
    [403, "FreeTierError: not a structured response"],
    [403, "null"],
    [403, "[]"],
    [401, JSON.stringify(payload)],
    [429, JSON.stringify(payload)],
    [500, JSON.stringify(payload)],
  ])("preserves base parser behavior for status %s / %s", (status, raw) => {
    const response = new Response(raw, { status });
    expect(executor.parseError(response, raw)).toEqual(BaseExecutor.prototype.parseError.call(executor, response, raw));
  });

  it("does not reclassify other providers' errors", async () => {
    const raw = JSON.stringify(payload);
    const parsed = await parseUpstreamError(new Response(raw, { status: 403 }), new BaseExecutor("opencode-go", {}));
    expect(parsed.message).toBe(raw);
    expect(parsed.statusCode).toBe(403);
  });

  it("passes the real gateway error format through a failed model probe", async () => {
    const parsed = await parseUpstreamError(new Response(JSON.stringify(payload), { status: 403 }), executor);
    const fetchMock = vi.fn(async () => createErrorResult(parsed.statusCode, parsed.message).response);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pingModelByKind("oc/deepseek-v4.1-flash-free", "llm", "http://spring-mouse.test");
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.error).toContain("HTTP 403");
    expect(result.error).toContain("上游限制免费层仅供 OpenCode 客户端使用");
    expect(result.error).toContain("模型目录同步成功不代表拥有调用权限");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://spring-mouse.test/api/v1/chat/completions");
  });
});
