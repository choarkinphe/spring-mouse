import { describe, expect, it } from "vitest";

import { normalizeComboStrategies, normalizeAutoRoutingConfig } from "../../open-sse/services/autoRouting.js";

describe("combo auto routing settings validation", () => {
  it("accepts a well-formed auto strategy and fills defaults", () => {
    const result = normalizeComboStrategies({
      route: {
        fallbackStrategy: "auto",
        autoRouting: { classifierModel: "cheap/classifier", defaultLevel: "simple", minConfidence: 0.5 },
      },
    }, { strict: true });

    expect(result.route.fallbackStrategy).toBe("auto");
    expect(result.route.autoRouting.classifierModel).toBe("cheap/classifier");
    expect(result.route.autoRouting.defaultLevel).toBe("simple");
    expect(result.route.autoRouting.minConfidence).toBe(0.5);
    expect(result.route.autoRouting.levelOrder.complex[0]).toBe("strong");
  });

  it("rejects a classifier that is not a direct provider/model identifier", () => {
    expect(() => normalizeComboStrategies({
      route: { fallbackStrategy: "auto", autoRouting: { classifierModel: "route" } },
    }, { strict: true })).toThrow(/classifierModel/);
  });

  it("rejects out-of-range numeric knobs", () => {
    expect(() => normalizeAutoRoutingConfig({ classifierTimeoutMs: 0 }, { strict: true })).toThrow(/classifierTimeoutMs/);
    expect(() => normalizeAutoRoutingConfig({ minConfidence: 2 }, { strict: true })).toThrow(/minConfidence/);
    expect(() => normalizeAutoRoutingConfig({ classifierMaxTokens: 100000 }, { strict: true })).toThrow(/classifierMaxTokens/);
  });

  it("rejects an incomplete level order", () => {
    expect(() => normalizeAutoRoutingConfig({ levelOrder: { complex: ["strong"] } }, { strict: true })).toThrow(/levelOrder/);
  });

  it("keeps unrelated strategy fields such as Fusion tuning", () => {
    const result = normalizeComboStrategies({
      route: { fallbackStrategy: "fusion", judgeModel: "strong/model", fusionTuning: { minPanel: 3 } },
    }, { strict: true });

    expect(result.route.judgeModel).toBe("strong/model");
    expect(result.route.fusionTuning).toEqual({ minPanel: 3 });
    expect(result.route.autoRouting).toBeUndefined();
  });

  it("rejects an unknown fallback strategy", () => {
    expect(() => normalizeComboStrategies({ route: { fallbackStrategy: "bogus" } }, { strict: true })).toThrow(/fallbackStrategy/);
  });
});
