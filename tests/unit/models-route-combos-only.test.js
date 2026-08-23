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
