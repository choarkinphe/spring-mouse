import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

afterEach(() => vi.restoreAllMocks());

async function executeError(payload, event = "error", prefix = "") {
  const text = `${prefix}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  const cancel = vi.fn();
  // Split inside the JSON to ensure a partial error cannot be classified early.
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset += 19));
      }
    }, cancel,
  }), { headers: { "content-type": "text/event-stream" } });
  const upstream = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
    .mockResolvedValue({ response });
  const result = await new CodexExecutor().execute({ model: "gpt-6-astra", body: {}, stream: true, credentials: {}, log: {} });
  return { result, upstream, cancel };
}

describe("Codex errors inside HTTP 200 SSE", () => {
  it("repairs before dispatch and records anonymous repair evidence", async () => {
    const upstream = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
      .mockImplementation(async ({ body }) => {
        expect(body.tools).toEqual([{ type: "web_search" }]);
        expect(body.tool_choice).toBe("none");
        return { response: new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n') };
      });
    const log = { errorLine: vi.fn() };
    const body = { input: [{ type: "web_search_call", action: { query: "PRIVATE_QUERY" } }], tools: [], tool_choice: "none" };
    const result = await new CodexExecutor().execute({ model: "gpt-6-astra", body, stream: true, credentials: {}, log });
    expect(result.response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const lines = log.errorLine.mock.calls.map((args) => args[2]);
    const metadata = JSON.parse(lines.find((line) => line.startsWith("CODEX-SCAN | ")).split("CODEX-SCAN | ")[1]);
    expect(metadata.hostedHistory).toMatchObject({ searchHistoryItems: 1, declarationRestored: true, toolsDisabled: true });
    expect(lines.join("\n")).not.toContain("PRIVATE_QUERY");
    await result.response.text();
  });

  it.each([
    [{ type: "error", error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Context limit exceeded" } }, "error", 400],
    [{ type: "response.failed", response: { error: { code: "invalid_encrypted_content", message: "Invalid encrypted content" } } }, "response.failed", 400],
    [{ type: "error", code: "rate_limit_exceeded", message: "Too many requests" }, "error", 429],
    [{ error: { code: "invalid_api_key", message: "Invalid credentials" } }, "error", 401],
    [{ error: { code: "new_provider_failure", message: "Provider failed" } }, "error", 502],
  ])("rejects an error without retrying it as an overload", async (payload, event, status) => {
    const { result, upstream, cancel } = await executeError(payload, event);
    expect(result.response.status).toBe(status);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.response.__smUpstreamError).toMatchObject({ source: "sse", status: 200 });
    expect((await result.response.json()).error.message).toBe(payload.error?.message || payload.response?.error?.message || payload.message);
  });

  it("retains error evidence without the echoed request preamble", async () => {
    const prefix = 'event: response.created\ndata: {"type":"response.created","response":{"instructions":"PRIVATE_PREAMBLE"}}\n\n';
    const { result } = await executeError({ error: { code: "new_provider_failure", message: "Provider failed" } }, "error", prefix);
    expect(result.response.__smUpstreamError.code).toBe("new_provider_failure");
    expect(result.response.__smUpstreamError.body).not.toContain("PRIVATE_PREAMBLE");
  });
});
