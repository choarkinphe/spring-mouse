import { describe, expect, it, vi } from "vitest";
import { createComboCapabilityResolver } from "../../open-sse/services/comboCapabilities.js";
import { getComboCapabilityValidationError, getComboModelsForRequest, isComboModelActive } from "../../open-sse/services/combo.js";
import { COMBO_RESOLUTION_LIMITS } from "../../open-sse/config/runtimeConfig.js";

const vision = { vision: true };
const image = new Set(["vision"]);
const leaf = "openai/gpt-4o";
const text = "deepseek/deepseek-chat";
const child = (name, models = [leaf], capabilities = vision, extra = {}) => ({ name, models, capabilities, ...extra });

describe("nested combo capabilities", () => {
  it("accepts nested and multi-level declarations and preserves wrapped nodes", () => {
    const combos = [child("inner"), child("middle", ["inner"])];
    const node = { model: "middle", autoTier: "strong", accessTags: ["team"] };
    expect(getComboCapabilityValidationError([node], vision, { combos })).toBeNull();
    expect(getComboModelsForRequest([text, node], image, vision, { combos })).toEqual([node]);
    expect(getComboModelsForRequest([node], image, vision, { combos })[0]).toBe(node);
  });

  it.each([
    child("gpt-4o", [leaf], { vision: false }),
    child("gpt-4o", [text]),
    child("gpt-4o", []),
    child("gpt-4o", [leaf], vision, { isActive: false }),
    child("gpt-4o", [leaf], vision, { kind: "webSearch" }),
  ])("does not borrow capabilities from a same-named actual model: %j", (combo) => {
    expect(getComboCapabilityValidationError([combo.name], vision, { combos: [combo] })).toContain("视觉");
    expect(getComboModelsForRequest([combo.name], image, vision, { combos: [combo] })).toEqual([]);
  });

  it("missing references never fall back to global model-name heuristics", () => {
    expect(getComboCapabilityValidationError(["gpt-4o"], vision, { combos: [] })).toContain("视觉");
    expect(getComboModelsForRequest(["gpt-4o"], image, vision, { combos: [] })).toEqual([]);
  });

  it("rejects cyclic-only paths but allows an independent leaf and reused siblings", () => {
    const combos = [child("a", ["b"]), child("b", ["a"])];
    expect(getComboCapabilityValidationError(["b"], vision, { combos, comboPath: ["a"] })).toContain("视觉");
    expect(getComboModelsForRequest(["a"], image, vision, { combos })).toEqual([]);
    combos[1].models.push(leaf);
    expect(getComboModelsForRequest(["a", "b"], image, vision, { combos })).toEqual(["a", "b"]);
  });

  it("bounds acyclic depth and wide repeated traversal", () => {
    const combos = Array.from({ length: COMBO_RESOLUTION_LIMITS.maxDepth + 1 }, (_, i) => child(`c${i}`, [`c${i + 1}`]));
    combos.at(-1).models = [leaf];
    expect(getComboModelsForRequest(["c0"], image, vision, { combos })).toEqual([]);
    const getModelCapabilities = vi.fn(() => ({ vision: false }));
    createComboCapabilityResolver({ combos: [child("wide", Array(COMBO_RESOLUTION_LIMITS.maxVisits + 10).fill(text))], getModelCapabilities }).supports("wide", ["vision"]);
    expect(getModelCapabilities.mock.calls.length).toBeLessThan(COMBO_RESOLUTION_LIMITS.maxVisits);
  });

  it("requires the same nested leaf to satisfy simultaneous input modalities", () => {
    const getModelCapabilities = (id) => ({ vision: id === "p/image", audioInput: id === "p/audio" });
    const combos = [child("split", ["p/image", "p/audio"], { vision: true, audioInput: true })];
    const options = { combos, getModelCapabilities };
    expect(getComboCapabilityValidationError(["split"], { vision: true, audioInput: true }, options)).toBeNull();
    expect(getComboModelsForRequest(["split"], new Set(["vision", "audioInput"]), { vision: true, audioInput: true }, options)).toEqual([]);
  });

  it("ignores schedules at save time and enforces runtime availability at every level", () => {
    const scheduled = { model: leaf, schedule: { timezone: "UTC", active: [{ start: "09:00", end: "10:00" }] } };
    const combos = [child("scheduled", [scheduled]), child("private")];
    expect(getComboCapabilityValidationError(["scheduled"], vision, { combos })).toBeNull();
    const options = {
      combos,
      isEntryAvailable: (entry) => isComboModelActive(entry, new Date("2026-01-01T12:00:00Z")),
      isComboAvailable: (combo) => combo.name !== "private",
    };
    expect(getComboModelsForRequest(["scheduled", "private", leaf], image, vision, options)).toEqual([leaf]);
  });

  it("uses the shared frontend leaf resolver without looking up bare combo names", () => {
    const getModelCapabilities = vi.fn(() => ({ vision: true, contextWindow: 999 }));
    const resolver = createComboCapabilityResolver({ combos: [child("gpt-4o", ["custom/model"], { vision: false, contextWindow: 128000 }), child("nested", ["custom/model"])], getModelCapabilities });
    expect(resolver.getCapabilities("gpt-4o")).toEqual({ vision: false, audioInput: false, contextWindow: 128000 });
    expect(resolver.getCapabilities("nested").vision).toBe(true);
    expect(resolver.getCapabilities("missing").vision).toBe(false);
    expect(getModelCapabilities.mock.calls.every(([id]) => id.includes("/"))).toBe(true);
  });

  it("preserves qualified provider/model and legacy no-catalog behavior", () => {
    expect(getComboCapabilityValidationError([leaf], vision, { combos: [child(leaf, [text])] })).toBeNull();
    expect(getComboCapabilityValidationError(["gpt-4o"], vision)).toBeNull();
    expect(getComboModelsForRequest([text, leaf], image, vision)).toEqual([leaf]);
    const models = [text, "nested"];
    expect(getComboModelsForRequest(models, new Set(), {}, { combos: [] })).toBe(models);
    expect(getComboCapabilityValidationError({}, vision)).toContain("视觉");
  });
});
