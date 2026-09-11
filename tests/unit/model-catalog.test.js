import { describe, expect, it } from "vitest";
import {
  capabilitiesFromModelsDev,
  mergeSyncedModels,
  MODEL_CAPABILITY_KEYS,
  normalizeModelCapabilities,
  parseModelsDevCatalog,
  pickModelCapabilities,
  resolveModelsDevProviderKey,
} from "../../src/shared/utils/modelCatalog.js";

describe("models.dev catalog normalization", () => {
  it("maps multimodal inputs and token limits into Spring Mouse capabilities", () => {
    expect(capabilitiesFromModelsDev({
      reasoning: true,
      tool_call: true,
      modalities: {
        input: ["text", "image", "video", "pdf"],
        output: ["text"],
      },
      limit: { context: 1_000_000, output: 131_072 },
    })).toEqual({
      vision: true,
      pdf: true,
      audioInput: false,
      videoInput: true,
      imageOutput: false,
      audioOutput: false,
      tools: true,
      reasoning: true,
      contextWindow: 1_000_000,
      maxOutput: 131_072,
    });
  });

  it("extracts and sorts a configured provider catalog", () => {
    const models = parseModelsDevCatalog({
      "zhipuai-coding-plan": {
        models: {
          "glm-5.3": {
            id: "glm-5.3",
            name: "GLM-5.3",
            release_date: "2026-08-14",
            modalities: { input: ["text"], output: ["text"] },
          },
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            release_date: "2026-08-26",
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    }, "zhipuai-coding-plan");

    expect(models.map((model) => model.id)).toEqual(["glm-5.3-flash", "glm-5.3"]);
    expect(models[0].capabilities).toMatchObject({ vision: true, pdf: true, reasoning: true });
  });
});

describe("model sync merge", () => {
  it("unions the provider list with the catalog instead of intersecting", () => {
    // Mirrors the real GLM-CN case: the account's /models endpoint returns a
    // subset, and the vision variants only exist in the catalog.
    const { models, catalogOnlyCount } = mergeSyncedModels({
      officialModels: [{ id: "glm-5.3" }, { id: "glm-4.7" }],
      catalogModels: [{ id: "glm-4.7" }, { id: "glm-4.6v", capabilities: { vision: true } }],
    });

    expect(models.map((model) => model.id)).toEqual(["glm-5.3", "glm-4.7", "glm-4.6v"]);
    expect(catalogOnlyCount).toBe(1);
    expect(models.find((model) => model.id === "glm-5.3").source).toBe("official");
    expect(models.find((model) => model.id === "glm-4.6v").source).toBe("catalog");
  });

  it("keeps the official entry when an id exists on both sides", () => {
    const { models, catalogOnlyCount } = mergeSyncedModels({
      officialModels: [{ id: "glm-4.7", name: "GLM-4.7" }],
      catalogModels: [{ id: "glm-4.7", name: "Catalog name", capabilities: { reasoning: true } }],
    });

    expect(models).toHaveLength(1);
    expect(catalogOnlyCount).toBe(0);
    expect(models[0].name).toBe("GLM-4.7");
    expect(models[0].source).toBe("official");
  });

  it("falls back to the catalog when the provider list is empty", () => {
    const { models, catalogOnlyCount } = mergeSyncedModels({
      officialModels: [],
      catalogModels: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
    });

    expect(models.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(catalogOnlyCount).toBe(2);
  });

  it("ignores entries without an id", () => {
    const { models } = mergeSyncedModels({
      officialModels: [null, { name: "no-id" }],
      catalogModels: [{ id: "ok" }],
    });
    expect(models.map((model) => model.id)).toEqual(["ok"]);
  });
});

describe("capability field plumbing", () => {
  it("resolves models.dev provider keys without a per-provider registry edit", () => {
    expect(resolveModelsDevProviderKey("glm-cn")).toBe("zhipuai-coding-plan");
    expect(resolveModelsDevProviderKey("deepseek")).toBe("deepseek");
    expect(resolveModelsDevProviderKey("claude")).toBe("anthropic");
    expect(resolveModelsDevProviderKey("gemini-cli")).toBe("google");
    expect(resolveModelsDevProviderKey("kiro")).toBeNull();
    expect(resolveModelsDevProviderKey("glm-cn", "explicit-key")).toBe("explicit-key");
  });

  it("round-trips every editable capability, including search", () => {
    expect(MODEL_CAPABILITY_KEYS).toContain("search");

    const normalized = normalizeModelCapabilities({
      vision: true,
      search: true,
      reasoning: false,
      contextWindow: 200000,
      maxOutput: 0,
      bogus: true,
    });

    expect(normalized).toEqual({ vision: true, search: true, reasoning: false, contextWindow: 200000 });
    expect(pickModelCapabilities(normalized)).toEqual(normalized);
  });

  it("drops null/undefined values when projecting for the dashboard", () => {
    expect(pickModelCapabilities({ vision: true, pdf: undefined, maxOutput: null })).toEqual({ vision: true });
  });
});
