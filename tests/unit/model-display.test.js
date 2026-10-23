import { describe, expect, it } from "vitest";
import { describeModelSource, getProviderCustomModelRows, getModelDisplayCapabilities } from "@/shared/utils/providerCustomModels.js";
import { createModelCapsCache } from "@/shared/utils/modelCapsCache.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const maps = (vision) => [{ fullModel: "ocg/deepseek-v4.1-flash", model: "deepseek-v4.1-flash", caps: { vision } }];

describe("model source and capability display", () => {
  it("preserves official origin independently of the custom storage category", () => {
    const [row] = getProviderCustomModelRows({ providerAlias: "ocg", customModels: [{ providerAlias: "ocg", id: "deepseek-v4.1-flash", source: "official", manualCapabilities: { vision: true } }] });
    expect(row.source).toBe("custom");
    expect(describeModelSource(row.modelSource)).toBe("官方同步");
    expect(getModelDisplayCapabilities(row, { vision: false, tools: true })).toEqual({ vision: true, tools: true });
  });
  it.each([true, false])("prioritizes explicit manual vision=%s over a cached result", (vision) => {
    expect(getModelDisplayCapabilities({ manualCapabilities: { vision } }, { vision: !vision }).vision).toBe(vision);
  });
  it("does not let declared capabilities overwrite current measured results", () => {
    expect(getModelDisplayCapabilities({ modelSource: "official", capabilities: { vision: true } }, { vision: false }).vision).toBe(false);
  });
  it("keeps another provider's row out of the displayed channel", () => {
    const rows = getProviderCustomModelRows({ providerAlias: "ocg", customModels: [{ providerAlias: "ds", id: "same", manualCapabilities: { vision: true } }] });
    expect(rows).toEqual([]);
  });
  it("does not invent official origin for manual models", () => {
    const [row] = getProviderCustomModelRows({ providerAlias: "ocg", customModels: [{ providerAlias: "ocg", id: "manual" }] });
    expect(describeModelSource(row.modelSource)).toBeNull();
  });
});

describe("model capability cache invalidation", () => {
  it("never replaces refreshed capabilities with a slower pre-edit response", async () => {
    const cache = createModelCapsCache();
    const old = deferred();
    const first = cache.load(() => old.promise);
    cache.clear();
    await cache.load(async () => maps(true));
    old.resolve(maps(false));
    await first;
    expect(cache.peek().byFull["ocg/deepseek-v4.1-flash"].vision).toBe(true);
  });
  it("deduplicates concurrent loads but not loads after invalidation", async () => {
    const cache = createModelCapsCache();
    const pending = deferred();
    const first = cache.load(() => pending.promise);
    expect(cache.load(() => Promise.reject())).toBe(first);
    cache.clear();
    const second = cache.load(async () => maps(true));
    expect(second).not.toBe(first);
    pending.resolve(maps(false));
    await Promise.all([first, second]);
    expect(cache.peek().byFull["ocg/deepseek-v4.1-flash"].vision).toBe(true);
  });
});
