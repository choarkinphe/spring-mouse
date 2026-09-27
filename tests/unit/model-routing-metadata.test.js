import { describe, expect, it } from "vitest";
import {
  createModelRouting,
  getExecutedModelLabel,
  isModelRouted,
  normalizeModelRouting,
} from "@/shared/utils/modelRouting.js";

describe("model routing metadata", () => {
  it("creates original and provider-qualified executed labels", () => {
    expect(createModelRouting({
      originalModel: "balanced",
      provider: "openai",
      model: "gpt-4o-mini",
    })).toEqual({
      originalModel: "balanced",
      executedModel: "openai/gpt-4o-mini",
    });
  });

  it("keeps direct requests on one model label", () => {
    expect(createModelRouting({
      originalModel: "gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
    })).toEqual({
      originalModel: "gpt-4o-mini",
      executedModel: "openai/gpt-4o-mini",
    });
    expect(isModelRouted({
      model: "gpt-4o-mini",
      provider: "openai",
      originalModel: "gpt-4o-mini",
      executedModel: "openai/gpt-4o-mini",
    })).toBe(false);
  });

  it("shows same-name cross-provider routing when explicitly marked", () => {
    expect(isModelRouted({
      model: "gpt-6-sol",
      provider: "codex",
      originalModel: "gpt-6-sol",
      executedModel: "codex/gpt-6-sol",
      routing: { routeKind: "alias", routed: true },
    })).toBe(true);
  });

  it("keeps same-name default-provider aliases direct when explicitly marked", () => {
    expect(isModelRouted({
      model: "gpt-4o-mini",
      provider: "openai",
      originalModel: "gpt-4o-mini",
      executedModel: "openai/gpt-4o-mini",
      routing: { routeKind: "alias", routed: false },
    })).toBe(false);
  });

  it("keeps legacy same-name cross-provider rows visible", () => {
    expect(isModelRouted({
      model: "gpt-6-sol",
      provider: "codex",
      originalModel: "gpt-6-sol",
      executedModel: "codex/gpt-6-sol",
    })).toBe(true);
  });

  it("preserves routing source metadata", () => {
    expect(createModelRouting({
      originalModel: "gpt-6-sol",
      provider: "codex",
      model: "gpt-6-sol",
      routeKind: "alias",
      routed: true,
    })).toEqual({
      originalModel: "gpt-6-sol",
      executedModel: "codex/gpt-6-sol",
      routeKind: "alias",
      routed: true,
    });
  });

  it("recognizes combo or alias routing", () => {
    expect(isModelRouted({
      model: "gpt-4o-mini",
      provider: "openai",
      originalModel: "combo",
      executedModel: "openai/gpt-4o-mini",
    })).toBe(true);
  });
  it("reads nested routing metadata", () => {
    expect(normalizeModelRouting({
      model: "openai/gpt-4o-mini",
      routing: {
        originalModel: "balanced",
        executedModel: "openai/gpt-4o-mini",
      },
    })).toMatchObject({
      originalModel: "balanced",
      executedModel: "openai/gpt-4o-mini",
      routing: {
        originalModel: "balanced",
        executedModel: "openai/gpt-4o-mini",
      },
    });
  });

  it("prefers explicit top-level values over nested values", () => {
    expect(normalizeModelRouting({
      model: "fallback",
      originalModel: "top-level-original",
      executedModel: "top-level-executed",
      routing: {
        originalModel: "nested-original",
        executedModel: "nested-executed",
      },
    })).toEqual({
      originalModel: "top-level-original",
      executedModel: "top-level-executed",
      routing: {
        originalModel: "top-level-original",
        executedModel: "top-level-executed",
      },
    });
  });

  it("falls back to legacy model records", () => {
    expect(normalizeModelRouting({ model: "legacy-model" })).toEqual({
      originalModel: "legacy-model",
      executedModel: "legacy-model",
      routing: {
        originalModel: "legacy-model",
        executedModel: "legacy-model",
      },
    });
    expect(getExecutedModelLabel({ provider: "openai", model: "legacy-model" }))
      .toBe("openai/legacy-model");
  });

  it("does not treat a provider-qualified original as a route", () => {
    expect(isModelRouted({
      model: "gpt-4o-mini",
      provider: "openai",
      originalModel: "openai/gpt-4o-mini",
      executedModel: "openai/gpt-4o-mini",
    })).toBe(false);
  });
});
