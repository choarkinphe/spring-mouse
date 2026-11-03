import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: false, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const model = "gpt-5.4";
const responseBody = { id: "resp_fixture", object: "response", model, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } };
const callCore = (body, credentials = {}) => handleChatCore({
  body: { model, input: "hello", ...body }, modelInfo: { provider: "openai", model }, credentials,
  sourceFormatOverride: "openai-responses", internalRequest: true, observabilityEnabled: false,
  clientRawRequest: { headers: {}, endpoint: "/v1/responses" },
});

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(async args => ({ response: Response.json(responseBody), transformedBody: args.body }));
});

describe("official OpenAI native Responses", () => {
  it.each([false, undefined])("keeps JSON Responses native with stream=%s", async stream => {
    const credentials = { apiKey: "synthetic-key" };
    const result = await callCore({ stream, store: false, max_output_tokens: 64, reasoning: { effort: "low", summary: "auto" } }, credentials);
    expect(execute).toHaveBeenCalledOnce();
    const args = execute.mock.calls[0][0];
    expect(args.stream).toBe(false);
    expect(args.body).toMatchObject({ input: "hello", stream: false, store: false, max_output_tokens: 64, reasoning: { effort: "low", summary: "auto" } });
    expect(args.body).not.toHaveProperty("reasoning_effort");
    expect(args.body).not.toHaveProperty("messages");
    const executor = new DefaultExecutor("openai");
    expect(executor.buildUrl(model, false, 0, credentials)).toBe("https://api.openai.com/v1/responses");
    expect(executor.transformRequest(model, args.body, false, credentials)).not.toHaveProperty("stream_options");
    expect(await result.response.json()).toMatchObject({ id: "resp_fixture", object: "response" });
  });

  it("keeps native Responses SSE and tools", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: responseBody })}\n\n`;
    execute.mockImplementation(async args => ({ response: new Response(sse, { headers: { "content-type": "text/event-stream" } }), transformedBody: args.body }));
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
    const result = await callCore({ stream: true, tools });
    const args = execute.mock.calls[0][0];
    expect(args.stream).toBe(true);
    expect(args.body).toMatchObject({ stream: true, tools });
    expect(await result.response.text()).toContain("response.completed");
  });

  it.each([{ previous_response_id: "resp_external" }, { conversation: "conv_external" }, { conversation: { id: "conv_external" } }])("rejects unbound server state before dispatch: %j", async state => {
    const result = await callCore({ stream: false, ...state });
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toContain("complete conversation history");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps Chat on its existing endpoint and requests usage", () => {
    const credentials = { apiKey: "synthetic-key", runtimeTransport: resolveTransport("openai", "openai") };
    const executor = new DefaultExecutor("openai");
    expect(executor.buildUrl(model, true, 0, credentials)).toBe("https://api.openai.com/v1/chat/completions");
    expect(executor.transformRequest(model, { messages: [] }, true, credentials).stream_options).toEqual({ include_usage: true });
  });

  it.each(["o1", "o3", "o4-mini", "o3-2025-04-16", "gpt-5.4"])("maps Chat output limits for %s", targetModel => {
    const executor = new DefaultExecutor("openai");
    const translated = translateRequest("openai-responses", "openai", targetModel, { input: "hi", max_output_tokens: 64 }, true, {}, "openai");
    const output = executor.transformRequest(targetModel, translated, true, {});
    expect(output.max_completion_tokens).toBe(64);
    expect(output).not.toHaveProperty("max_tokens");
    expect(executor.transformRequest(targetModel, { max_tokens: 64, max_completion_tokens: 32 }, false, {})).toMatchObject({ max_completion_tokens: 32 });
  });

  it("leaves native Responses limits untouched", () => {
    const credentials = { runtimeTransport: resolveTransport("openai", "openai-responses") };
    const body = { input: "hi", max_output_tokens: 64 };
    expect(new DefaultExecutor("openai").transformRequest("o3", body, false, credentials)).toEqual(body);
  });

  it("does not change legacy models or other providers", () => {
    expect(new DefaultExecutor("openai").transformRequest("gpt-4o", { max_tokens: 64 }, false, {})).toMatchObject({ max_tokens: 64 });
    expect(new DefaultExecutor("groq").transformRequest("o3", { max_tokens: 64 }, false, {})).toMatchObject({ max_tokens: 64 });
  });
});
