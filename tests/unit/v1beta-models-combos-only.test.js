import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-v1beta-models-"));

let createCombo;
let GET;

beforeAll(async () => {
  ({ createCombo } = await import("@/lib/localDb"));
  ({ GET } = await import("@/app/api/v1beta/models/route.js"));
});

describe("Gemini models list", () => {
  it("returns only configured combos", async () => {
    await createCombo({ name: "empty-route", models: [], kind: null });
    await createCombo({ name: "gemini-route", models: ["gemini/gemini-2.5-pro"], kind: null, capabilities: { contextWindow: 1048576, vision: true, audioInput: true } });
    await createCombo({ name: "paused-route", models: ["gemini/gemini-2.5-flash"], kind: null, isActive: false });

    const response = await GET();
    await expect(response.json()).resolves.toEqual({
      models: [{
        name: "models/gemini-route",
        displayName: "gemini-route",
        description: "Configured routing combo",
        inputTokenLimit: 1048576,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      }],
    });
  });
});
