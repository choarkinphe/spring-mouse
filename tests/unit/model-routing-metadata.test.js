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
    })).toEqual({
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
