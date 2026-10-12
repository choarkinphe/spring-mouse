import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => Response.json(body, init) } }));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn(), getProviderConnectionById: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getPricingForModel, PROVIDER_PRICING } from "../../open-sse/providers/pricing.js";
import {
  JEVAPI_CONFIG,
  JEVAPI_QUESTION_TYPES,
  JEVAPI_STATIC_MODELS,
  parseJevapiModels,
} from "../../open-sse/config/jevapi.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

// Upstream `GET /v1/models` shape (docs.typesafe.ai/api.md).
const FIXTURE_PAYLOAD = {
  models: [
    { name: "jev-latest", description: "Latest fixture model", release_date: "2026-09-15" },
    { name: "jev-preview", description: "Preview fixture model", release_date: "2026-09-15" },
  ],
};

describe("JevAPI provider registration", () => {
  it("is present in the generated registry with the expected identity", () => {
    const entry = REGISTRY.find((r) => r.id === "jevapi");
    expect(entry).toBeTruthy();
    expect(entry.alias).toBe("jevapi");
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.modelListSource).toBe("upstream");
    expect(entry.display.name).toBe("JevAPI");
    expect(entry.display.notice.apiKeyUrl).toBe("https://console.typesafe.ai");
  });

  it("declares only the native systemone service kind (never llm)", () => {
    const entry = REGISTRY.find((r) => r.id === "jevapi");
    expect(entry.serviceKinds).toEqual(["systemone"]);
    expect(entry.serviceKinds).not.toContain("llm");
  });

  it("has no chat transport (PROVIDERS.jevapi stays undefined)", () => {
    expect(PROVIDERS.jevapi).toBeUndefined();
  });

  it("exposes native config + modelsFetcher through PROVIDER_MEDIA", () => {
    expect(PROVIDER_MEDIA.jevapi.serviceKinds).toEqual(["systemone"]);
    expect(PROVIDER_MEDIA.jevapi.systemoneConfig).toMatchObject({
      baseUrl: JEVAPI_CONFIG.baseUrl,
      modelsUrl: JEVAPI_CONFIG.modelsUrl,
      defaultModel: JEVAPI_CONFIG.defaultModel,
    });
    expect(PROVIDER_MEDIA.jevapi.modelsFetcher).toMatchObject({
      url: JEVAPI_CONFIG.modelsUrl,
      type: "jevapi-systemone",
    });
  });

  it("carries systemoneConfig into the dashboard provider object", async () => {
    const { AI_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    expect(AI_PROVIDERS.jevapi.systemoneConfig?.baseUrl).toBe(JEVAPI_CONFIG.baseUrl);
  });

  it("resolves jev-* capabilities as non-chat (tools disabled)", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const caps = getCapabilitiesForModel("jevapi", "jev-latest");
    expect(caps.tools).toBe(false);
    expect(caps.search).toBe(false);
  });

  it("seeds static models typed systemone with chat tools disabled", () => {
    const models = PROVIDER_MODELS.jevapi;
    expect(models.map((m) => m.id)).toEqual(JEVAPI_STATIC_MODELS);
    for (const model of models) {
      expect(model.type).toBe("systemone");
      expect(model.capabilities).toMatchObject({ tools: false });
    }
  });

  it("exposes the native question types", () => {
    expect(JEVAPI_QUESTION_TYPES).toEqual({ NOUL: "noul", CHOICE: "choice", SCORE: "score" });
  });
});

describe("JevAPI is never offered as a chat provider", () => {
  it("is flagged as a non-chat service provider", async () => {
    const { isNonChatServiceProvider } = await import("../../src/shared/constants/providers.js");
    expect(isNonChatServiceProvider("jevapi")).toBe(true);
    // Sanity: normal chat providers are unaffected.
    expect(isNonChatServiceProvider("openai")).toBe(false);
    expect(isNonChatServiceProvider("nanobanana")).toBe(false);
  });

  it("is excluded from the llm kind list but present under systemone", async () => {
    const { getProvidersByKind } = await import("../../src/shared/constants/providers.js");
    expect(getProvidersByKind("llm").some((p) => p.id === "jevapi")).toBe(false);
    expect(getProvidersByKind("systemone").some((p) => p.id === "jevapi")).toBe(true);
  });

  it("registers systemone as a dashboard media kind", async () => {
    const { MEDIA_PROVIDER_KINDS } = await import("../../src/shared/constants/providers.js");
    const kind = MEDIA_PROVIDER_KINDS.find((k) => k.id === "systemone");
    expect(kind).toBeTruthy();
    expect(kind.endpoint.path).toBe("/v1/systemone");
  });

  it("is wired for live model sync", async () => {
    const { supportsLiveModelSync } = await import("../../src/shared/constants/providers.js");
    expect(supportsLiveModelSync("jevapi")).toBe(true);
  });
});

describe("JevAPI model listing parsing", () => {
  it("maps the upstream {models:[{name,description,release_date}]} shape", () => {
    const models = parseJevapiModels(FIXTURE_PAYLOAD);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "jev-latest",
      name: "jev-latest",
      type: "systemone",
      description: "Latest fixture model",
      releaseDate: "2026-09-15",
    });
    expect(models[0].capabilities).toMatchObject({ tools: false });
  });

  it("keeps a synced model typed systemone so model-sync never defaults it to llm", () => {
    for (const model of parseJevapiModels(FIXTURE_PAYLOAD)) {
      expect(model.type).toBe("systemone");
    }
  });

  it("accepts a bare array and de-duplicates ids", () => {
    const models = parseJevapiModels(["jev-latest", "jev-latest", { name: "jev-preview" }]);
    expect(models.map((m) => m.id)).toEqual(["jev-latest", "jev-preview"]);
  });

  it("returns [] for malformed payloads", () => {
    expect(parseJevapiModels(null)).toEqual([]);
    expect(parseJevapiModels({})).toEqual([]);
    expect(parseJevapiModels({ models: "nope" })).toEqual([]);
    expect(parseJevapiModels({ models: [{}] })).toEqual([]);
  });

  it("is wired as the suggested-models filter", () => {
    expect(FILTERS["jevapi-systemone"]).toBeTypeOf("function");
    const models = FILTERS["jevapi-systemone"](FIXTURE_PAYLOAD.models);
    expect(models.map((m) => m.id)).toEqual(["jev-latest", "jev-preview"]);
  });
});

describe("JevAPI management endpoints", () => {
  it.each([200, 401, 403, 404, 429, 500, 529])("only validates successful upstream responses: %s", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(status === 200 ? FIXTURE_PAYLOAD : { error: "fixture failure" }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "jevapi", apiKey: "fixture-key" }),
    }));
    expect((await response.json()).valid).toBe(status === 200);
    expect(fetchMock).toHaveBeenCalledWith(JEVAPI_CONFIG.modelsUrl, expect.objectContaining({ headers: { Authorization: "Bearer fixture-key" } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists native typed models through the connection models endpoint", async () => {
    const { getProviderConnectionById } = await import("@/models");
    getProviderConnectionById.mockResolvedValue({ id: "conn", provider: "jevapi", apiKey: "fixture-key" });
    const fetchMock = vi.fn().mockResolvedValue(Response.json(FIXTURE_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(new Request("http://localhost/api/providers/conn/models"), { params: Promise.resolve({ id: "conn" }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.models.map((model) => [model.id, model.type])).toEqual([["jev-latest", "systemone"], ["jev-preview", "systemone"]]);
    expect(JSON.stringify(data)).not.toContain("fixture-key");
    expect(fetchMock.mock.calls[0][0]).toBe(JEVAPI_CONFIG.modelsUrl);
  });
});

describe("JevAPI validation + pricing config", () => {
  it("points the native config at the documented endpoints", () => {
    expect(JEVAPI_CONFIG.provider).toBe("jevapi");
    expect(JEVAPI_CONFIG.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JEVAPI_CONFIG.modelsUrl).toBe("https://api.typesafe.ai/v1/models");
    expect(JEVAPI_CONFIG.defaultModel).toBe("jev-latest");
    expect(JEVAPI_CONFIG.authHeader).toBe("Authorization");
    expect(JEVAPI_CONFIG.authScheme).toBe("bearer");
  });

  it("prices input only (0.042 / 0) and resolves through PROVIDER_PRICING", () => {
    expect(PROVIDER_PRICING.jevapi["jev-latest"]).toEqual({ input: 0.042, output: 0 });
    expect(getPricingForModel("jevapi", "jev-latest")).toEqual({ input: 0.042, output: 0 });
  });
});
