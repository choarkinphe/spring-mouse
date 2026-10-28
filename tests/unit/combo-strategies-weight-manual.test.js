import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  getRotatedModelsForCount,
  weightedMemberIndexForCount,
  normalizeComboModelsForStorage,
  normalizeMemberEffort,
  normalizeMemberWeight,
  comboModelEntry,
  handleComboChat,
  resetComboRotation,
} from "../../open-sse/services/combo.js";
import { normalizeComboStrategies, ROTATING_STRATEGIES } from "../../open-sse/services/autoRouting.js";

const quietLog = { info: () => {}, warn: () => {}, debug: () => {} };
const okResponse = () => new Response("ok", { status: 200 });

beforeEach(() => resetComboRotation());

describe("weighted rotation", () => {
  it("serves members in their configured proportions", () => {
    const tally = (weights, requests) => {
      const counts = new Array(weights.length).fill(0);
      for (let n = 1; n <= requests; n++) counts[weightedMemberIndexForCount(n, weights)]++;
      return counts;
    };

    // 3:1 promises exactly 3:1, spread rather than in one burst.
    expect(tally([3, 1], 400)).toEqual([300, 100]);
    expect(tally([1, 2, 3], 1200)).toEqual([200, 400, 600]);
  });

  it("is a pure function of the request count", () => {
    // Same property that makes the shared Redis counter work across workers.
    expect(weightedMemberIndexForCount(7, [2, 1, 4])).toBe(weightedMemberIndexForCount(7, [2, 1, 4]));
  });

  it("interleaves rather than emitting one member's whole share at once", () => {
    const picks = Array.from({ length: 4 }, (_, i) => weightedMemberIndexForCount(i + 1, [1, 1]));
    expect(new Set(picks).size).toBe(2);
  });

  it("keeps the weighted pick first and the others as fallbacks", () => {
    const models = ["a", "b", "c"];
    const order = getRotatedModelsForCount(models, 2, "weighted", 1, [3, 1, 1]);
    expect(order[0]).toBe("a");
    expect([...order].sort()).toEqual(models);
  });

  it("degenerates safely", () => {
    expect(weightedMemberIndexForCount(5, [])).toBe(0);
    expect(weightedMemberIndexForCount(5, [1])).toBe(0);
    expect(weightedMemberIndexForCount(3, [0, -3])).toBe(0);
    expect(weightedMemberIndexForCount(0, [1, 1])).toBe(0);
  });
});

describe("manual routing", () => {
  it("sends every request to the pinned member and does not fall back", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      return new Response("nope", { status: 500 });
    });

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a", "b"],
      handleSingleModel,
      log: quietLog,
      comboName: "pinned",
      comboStrategy: "manual",
      pickModel: "b",
    });

    // One attempt, on the pinned member — a failure is the answer, not a cue to
    // try the others.
    expect(calls).toEqual(["b"]);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
  });

  it("refuses rather than routing elsewhere when the pin is unusable", async () => {
    const handleSingleModel = vi.fn(async () => okResponse());

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a"],
      handleSingleModel,
      log: quietLog,
      comboName: "pinned",
      comboStrategy: "manual",
      pickModel: "gone",
    });

    expect(handleSingleModel).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("gone");
  });
});

describe("member effort", () => {
  it("passes each fallback member's ceiling in context without mutating the request or entries", async () => {
    const body = { messages: [{ role: "user", content: "hello" }], reasoning_effort: "high" };
    const memberEntries = [{ model: "a", effort: "low" }, { model: "b", effort: "xhigh" }, { model: "c" }];
    const originalBody = structuredClone(body);
    const originalEntries = structuredClone(memberEntries);
    const handleSingleModel = vi.fn(async (_body, model) =>
      model === "c" ? okResponse() : new Response("unavailable", { status: 503 }));

    const response = await handleComboChat({
      body,
      models: ["a", "b", "c"],
      handleSingleModel,
      log: quietLog,
      comboName: "effort",
      comboStrategy: "fallback",
      autoSwitch: false,
      memberEntries,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel.mock.calls).toEqual([
      [body, "a", { comboPath: ["effort"], hasFallback: true, maxEffort: "low" }],
      [body, "b", { comboPath: ["effort"], hasFallback: true, maxEffort: "xhigh" }],
      [body, "c", { comboPath: ["effort"], hasFallback: false, maxEffort: null }],
    ]);
    expect(body).toEqual(originalBody);
    expect(memberEntries).toEqual(originalEntries);
  });

  it("uses the pinned manual member's ceiling without mutating the request or entries", async () => {
    const body = { messages: [{ role: "user", content: "hello" }], reasoning_effort: "high" };
    const memberEntries = [{ model: "a", effort: "low" }, { model: "b", effort: "xhigh" }];
    const originalBody = structuredClone(body);
    const originalEntries = structuredClone(memberEntries);
    const handleSingleModel = vi.fn(async () => okResponse());

    const response = await handleComboChat({
      body,
      models: ["a", "b"],
      handleSingleModel,
      log: quietLog,
      comboName: "manual-effort",
      comboStrategy: "manual",
      pickModel: "b",
      memberEntries,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledExactlyOnceWith(body, "b", {
      comboPath: ["manual-effort"], hasFallback: false, maxEffort: "xhigh",
    });
    expect(body).toEqual(originalBody);
    expect(memberEntries).toEqual(originalEntries);
  });
});

describe("member effort and weight storage", () => {
  it("accepts every level the translator understands", () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(normalizeMemberEffort(level)).toBe(level);
    }
    expect(normalizeMemberEffort("HIGH")).toBe("high");
  });

  it("rejects an unknown effort instead of silently ignoring it", () => {
    expect(normalizeMemberEffort("turbo")).toBeNull();
    expect(normalizeComboModelsForStorage([{ model: "a", effort: "turbo" }])).toBeNull();
  });

  it("clamps weights into the supported range", () => {
    expect(normalizeMemberWeight(0)).toBe(1);
    expect(normalizeMemberWeight(9999)).toBe(1000);
    expect(normalizeMemberWeight("abc")).toBe(1);
    expect(normalizeMemberWeight(7)).toBe(7);
  });

  it("keeps a plain string entry a string unless something is configured", () => {
    expect(normalizeComboModelsForStorage(["a"])).toEqual(["a"]);
    expect(normalizeComboModelsForStorage([{ model: "a", weight: 1, effort: null }])).toEqual(["a"]);
    expect(normalizeComboModelsForStorage([{ model: "a", weight: 3 }])).toEqual([{ model: "a", weight: 3 }]);
  });

  it("reads back what it stored", () => {
    const entry = comboModelEntry({ model: "a", effort: "xhigh", weight: 4 });
    expect(entry.effort).toBe("xhigh");
    expect(entry.weight).toBe(4);
  });
});

describe("strategy normalization", () => {
  it("accepts the new strategies", () => {
    const out = normalizeComboStrategies({
      c1: { fallbackStrategy: "weighted" },
      c2: { fallbackStrategy: "manual", pick: "a/b" },
    }, { strict: true });
    expect(out.c1.fallbackStrategy).toBe("weighted");
    expect(out.c2.pick).toBe("a/b");
  });

  it("drops a pin that no longer applies", () => {
    const out = normalizeComboStrategies({ c1: { fallbackStrategy: "manual", pick: "  " } });
    expect(out.c1.pick).toBeUndefined();
    const switched = normalizeComboStrategies({ c2: { fallbackStrategy: "fallback", pick: "a/b" } });
    expect(switched.c2.pick).toBeUndefined();
  });

  it("rejects an unknown strategy", () => {
    expect(() => normalizeComboStrategies({ c1: { fallbackStrategy: "magic" } }, { strict: true })).toThrow();
  });

  it("classifies which strategies need a shared counter", () => {
    expect(ROTATING_STRATEGIES.has("round-robin")).toBe(true);
    expect(ROTATING_STRATEGIES.has("weighted")).toBe(true);
    expect(ROTATING_STRATEGIES.has("fallback")).toBe(false);
    expect(ROTATING_STRATEGIES.has("manual")).toBe(false);
    expect(ROTATING_STRATEGIES.has("auto")).toBe(false);
  });
});
