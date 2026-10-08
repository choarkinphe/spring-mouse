import { afterEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { QIANWEN_ENDPOINTS, QIANWEN_PROVIDER_IDS } from "../../open-sse/config/qianwen.js";
import { supportsLiveModelSync, APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { resolveModelsDevProviderKey } from "../../src/shared/utils/modelCatalog.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => globalThis.fetch(...args),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }) } }));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn(), getProviderConnectionById: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("Qianwen API and Token Plan", () => {
  it("registers distinct channels and preserves disabled providers", () => {
    for (const id of QIANWEN_PROVIDER_IDS) {
      expect(REGISTRY.find((e) => e.id === id)?.category).toBe("apikey");
      expect(APIKEY_PROVIDERS[id]).toBeDefined();
      expect(supportsLiveModelSync(id)).toBe(true);
      expect(getProviderIconSrc(id)).toBe("/providers/qianwen.png");
    }
    expect(new URL(PROVIDERS.qianwen.baseUrl).host).not.toBe(new URL(PROVIDERS["qianwen-token-plan"].baseUrl).host);
    expect(new Set(REGISTRY.map((e) => e.id)).size).toBe(REGISTRY.length);
    for (const id of ["trae", "windsurf", "devin-cli"]) expect(REGISTRY.some((e) => e.id === id)).toBe(false);
  });

  it.each(QIANWEN_PROVIDER_IDS)("uses native endpoints and bearer auth for %s", (id) => {
    const executor = new DefaultExecutor(id);
    for (const [format, path] of [["openai", "chat"], ["openai-responses", "responses"], ["claude", "messages"]]) {
      const runtimeTransport = resolveTransport(id, format);
      const credentials = { apiKey: "test-only", runtimeTransport };
      expect(executor.buildUrl("qwen3.8-flash", true, 0, credentials)).toBe(QIANWEN_ENDPOINTS[id][path]);
      expect(executor.buildHeaders(credentials, true).Authorization).toBe("Bearer test-only");
    }
    expect(executor.transformRequest("qwen3.8-flash", { messages: [] }, true, {})).toMatchObject({ stream_options: { include_usage: true } });
  });

  it.each(QIANWEN_PROVIDER_IDS)("exposes vision and reference pricing for %s", (id) => {
    expect(getModelsByProviderId(id).some((m) => m.id === "qwen3.8-flash")).toBe(true);
    expect(getCapabilitiesForModel(id, "qwen3.8-flash")).toMatchObject({ vision: true, videoInput: true, contextWindow: 1000000, maxOutput: 131072 });
    expect(getCapabilitiesForModel(id, "qwen3.7-max").vision).toBe(false);
    expect(getCapabilitiesForModel(id, "deepseek-v4.1-flash").vision).toBe(true);
    expect(getPricingForModel(id, "qwen3.8-flash")).toMatchObject({ input: 0.11875, output: 0.40073 });
  });

  it.each(QIANWEN_PROVIDER_IDS)("serializes thinking in the native wire format for %s", (id) => {
    const chat = applyThinking("openai", "qwen3.8-flash(high)", {}, id);
    expect(chat.enable_thinking).toBe(true);
    expect(chat.thinking_budget).toBeGreaterThan(0);
    const responses = applyThinking("openai-responses", "qwen3.8-flash(high)", {}, id);
    expect(responses).toEqual({ reasoning: { effort: "high" } });
    const claude = applyThinking("claude", "qwen3.8-flash(high)", {}, id);
    expect(claude.thinking).toMatchObject({ type: "enabled" });
    expect(claude.enable_thinking).toBeUndefined();
    expect(applyThinking("openai-responses", "qwen3.8-flash(none)", {}, id)).toEqual({ reasoning: { effort: "none" } });
  });

  it.each(QIANWEN_PROVIDER_IDS)("preserves Responses reasoning levels for %s", (id) => {
    for (const effort of ["low", "medium", "high", "xhigh", "none"]) {
      const body = translateRequest("openai-responses", "openai-responses", "qwen3.8-flash", {
        input: "hello", reasoning: { effort },
      }, true, {}, id);
      expect(body.reasoning).toEqual({ effort });
      expect(body.enable_thinking).toBeUndefined();
      expect(body.thinking_budget).toBeUndefined();
    }
    expect(applyThinking("openai-responses", "qwen3.8-flash(max)", {}, id)).toEqual({ reasoning: { effort: "xhigh" } });
    expect(applyThinking("openai-responses", "qwen3.8-flash(auto)", {}, id)).toEqual({ enable_thinking: true });
  });

  it.each(QIANWEN_PROVIDER_IDS)("does not disable thinking-only GLM-5.3 for %s", (id) => {
    expect(getCapabilitiesForModel(id, "glm-5.3").thinkingCanDisable).toBe(false);
    expect(applyThinking("openai", "glm-5.3(none)", {}, id).enable_thinking).toBe(true);
    expect(applyThinking("openai-responses", "glm-5.3(none)", {}, id)).toEqual({ reasoning: { effort: "minimal" } });
    expect(applyThinking("claude", "glm-5.3(none)", {}, id).thinking.type).toBe("enabled");
  });

  it.each(QIANWEN_PROVIDER_IDS)("dispatches each protocol in stream and nonstream modes for %s", async (id) => {
    for (const format of ["openai", "openai-responses", "claude"]) {
      for (const stream of [false, true]) {
        const credentials = { apiKey: "test-only", runtimeTransport: resolveTransport(id, format) };
        const input = format === "openai-responses"
          ? { input: "hello", reasoning: { effort: "low" } }
          : { messages: [{ role: "user", content: "hello" }], max_tokens: 32768 };
        const body = translateRequest(format, format, "qwen3.8-flash(low)", input, stream, credentials, id);
        body.model = "qwen3.8-flash";
        body.stream = stream;
        const fetchMock = vi.fn().mockResolvedValue(new Response(stream ? "data: [DONE]\n\n" : '{"ok":true}', {
          headers: { "content-type": stream ? "text/event-stream" : "application/json" },
        }));
        vi.stubGlobal("fetch", fetchMock);
        const result = await new DefaultExecutor(id).execute({ model: body.model, body, stream, credentials });
        expect(result.response.ok).toBe(true);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe(credentials.runtimeTransport.baseUrl);
        expect(options.headers.Authorization).toBe("Bearer test-only");
        const sent = JSON.parse(options.body);
        expect(sent.stream).toBe(stream);
        if (format === "openai") {
          expect(sent.enable_thinking).toBe(true);
          expect(sent.stream_options?.include_usage).toBe(stream ? true : undefined);
        } else if (format === "openai-responses") {
          expect(sent.reasoning.effort).toBe("low");
          expect(sent.stream_options).toBeUndefined();
          expect(sent.thinking_budget).toBeUndefined();
        } else {
          expect(options.headers["anthropic-version"]).toBe("2023-06-01");
          expect(sent.thinking.type).toBe("enabled");
          expect(sent.enable_thinking).toBeUndefined();
        }
      }
    }
  });

  it("keeps subscription-only models out of the API seed and maps separate catalogs", () => {
    expect(getModelsByProviderId("qianwen").some((m) => m.id === "auto")).toBe(false);
    expect(getModelsByProviderId("qianwen-token-plan").some((m) => m.id === "auto")).toBe(true);
    expect(resolveModelsDevProviderKey("qianwen")).toBe("alibaba-cn");
    expect(resolveModelsDevProviderKey("qianwen-token-plan")).toBe("alibaba-token-plan-cn");
  });

  it.each(QIANWEN_PROVIDER_IDS)("validates %s with its own models endpoint and rejects auth failures", async (provider) => {
    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = () => new Request("http://localhost/api/providers/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey: "test-only" }) });
    expect((await (await POST(request())).json()).valid).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(QIANWEN_ENDPOINTS[provider].models);
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    expect((await (await POST(request())).json()).valid).toBe(false);
  });

  it.each(QIANWEN_PROVIDER_IDS)("lists live models for %s without leaking the key", async (provider) => {
    const { getProviderConnectionById } = await import("@/models");
    getProviderConnectionById.mockResolvedValue({ id: "conn", provider, apiKey: "test-only" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "qwen3.8-flash", capabilities: { vision: true } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await GET(new Request("http://localhost/api/providers/conn/models"), { params: Promise.resolve({ id: "conn" }) });
    const data = await res.json();
    expect(data.models).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(QIANWEN_ENDPOINTS[provider].models);
    expect(JSON.stringify(data)).not.toContain("test-only");
    fetchMock.mockResolvedValue(new Response('{"error":"unexpected envelope"}', { status: 200 }));
    const malformed = await GET(new Request("http://localhost/api/providers/conn/models"), { params: Promise.resolve({ id: "conn" }) });
    expect(malformed.status).toBe(502);
    fetchMock.mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    const empty = await GET(new Request("http://localhost/api/providers/conn/models"), { params: Promise.resolve({ id: "conn" }) });
    expect(empty.status).toBe(200);
    expect((await empty.json()).models).toEqual([]);
  });
});
