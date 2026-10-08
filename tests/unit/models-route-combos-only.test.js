import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-models-"));

let createCombo;
let buildModelsList;

beforeAll(async () => {
  ({ createCombo } = await import("@/lib/localDb"));
  ({ buildModelsList } = await import("@/app/api/v1/models/route.js"));
});

describe("public models list", () => {
  it("returns configured combos without direct provider models", async () => {
    await createCombo({ name: "empty-route", models: [], kind: null });
    await createCombo({ name: "main-route", models: ["cx/gpt-5"], kind: null });
    await createCombo({ name: "paused-route", models: ["cx/gpt-5-mini"], kind: null, isActive: false });
    await createCombo({ name: "web-route", models: ["google/search"], kind: "webSearch" });
    await createCombo({ name: "gpt-route", models: ["cx/gpt-5"], kind: null, groupName: "GPT", sortOrder: 10 });

    const models = await buildModelsList(["llm"]);

    expect(models).toEqual([
      { id: "main-route", object: "model", owned_by: "combo", is_combo: true },
      { id: "gpt-route", object: "model", owned_by: "GPT", is_combo: true },
    ]);
  });

  it("hides tagged combos from API keys without matching tags", async () => {
    await createCombo({ name: "restricted-route", models: ["cx/gpt-5"], kind: null, accessTags: ["team-a"] });

    const deniedModels = await buildModelsList(["llm"], { accessTags: ["team-b"] });
    const allowedModels = await buildModelsList(["llm"], { accessTags: ["team-a"] });

    expect(deniedModels.some((model) => model.id === "restricted-route")).toBe(false);
    expect(allowedModels.some((model) => model.id === "restricted-route")).toBe(true);
  });

  it("keeps the internal Qianwen catalog limited to upstream and manual rows", async () => {
    const { createProviderConnection, syncCustomModels, addCustomModel } = await import("@/lib/localDb");
    await createProviderConnection({ provider: "qianwen", authType: "apikey", apiKey: "test-only" });
    await syncCustomModels([
      { providerAlias: "qianwen", id: "live", source: "official" },
      { providerAlias: "qianwen", id: "catalog-only", source: "catalog" },
      { providerAlias: "qianwen", id: "static-only", source: "static" },
    ]);
    await addCustomModel({ providerAlias: "qianwen", id: "manual" });
    const models = await buildModelsList(["llm"], { skipDynamicFetch: true, includeProviderModels: true });
    expect(models.filter(m => m.owned_by === "qianwen").map(m => m.id).sort()).toEqual(["qianwen/live", "qianwen/manual"]);
    const { GET } = await import("@/app/api/models/route.js");
    const response = await GET(new Request("http://localhost/api/models"));
    const data = await response.json();
    expect(data.models.filter(m => m.provider === "qianwen").map(m => m.model).sort()).toEqual(["live", "manual"]);
  });

  it("exposes a combo's declared context and input capabilities", async () => {
    await createCombo({
      name: "media-route",
      models: ["oc/mimo-v2.5-free"],
      kind: null,
      capabilities: { contextWindow: 1048576, vision: true, audioInput: true },
    });

    const models = await buildModelsList(["llm"]);
    expect(models).toContainEqual({
      id: "media-route",
      object: "model",
      owned_by: "combo",
      is_combo: true,
      context_window: 1048576,
      capabilities: { vision: true, audio_input: true },
    });
  });
});
