import { describe, expect, it } from "vitest";
import {
  calculateCostFromTokens, getPricingForModel, resolveOpenCodeGoPricing,
} from "../../open-sse/providers/pricing.js";

// Weekday peak windows (UTC): Mon-Fri 01:00-04:00 and 06:00-10:00.
const weekdayPeak = new Date("2026-11-16T02:00:00Z"); // Monday
const weekdayOffPeak = new Date("2026-11-16T05:00:00Z"); // Monday, between windows
const weekendPeak = new Date("2026-11-15T02:00:00Z"); // Sunday, same clock time

const deepseekPro = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };

describe("OpenCode Go pricing resolver", () => {
  it("returns the static base rate without context", () => {
    expect(resolveOpenCodeGoPricing("deepseek-v4-pro")).toMatchObject({ input: 0.66, output: 1.98 });
    expect(resolveOpenCodeGoPricing("kimi-k3")).toMatchObject({ input: 3, output: 15, cache_creation: 3 });
  });

  it("doubles DeepSeek rates during weekday peak windows and nowhere else", () => {
    expect(resolveOpenCodeGoPricing("deepseek-v4-pro", { at: weekdayPeak })).toMatchObject({ input: 1.32, output: 3.96, cached: 0.044 });
    expect(resolveOpenCodeGoPricing("deepseek-v4-pro", { at: weekdayOffPeak })).toMatchObject({ input: 0.66, output: 1.98 });
    expect(resolveOpenCodeGoPricing("deepseek-v4-pro", { at: weekendPeak })).toMatchObject({ input: 0.66, output: 1.98 });
    // Non-DeepSeek models have no peak multiplier.
    expect(resolveOpenCodeGoPricing("glm-5.2", { at: weekdayPeak })).toMatchObject({ input: 1.4, output: 4.4 });
  });

  it("applies the long-context band above the threshold only", () => {
    expect(resolveOpenCodeGoPricing("grok-4.7", { promptTokens: 200_000 })).toMatchObject({ input: 2, output: 6 });
    expect(resolveOpenCodeGoPricing("grok-4.7", { promptTokens: 200_001 })).toMatchObject({ input: 4, output: 12, cached: 1 });
    // Step rates must not leak the threshold key into the pricing object.
    expect(resolveOpenCodeGoPricing("grok-4.7", { promptTokens: 300_000 })).not.toHaveProperty("above");
  });

  it("composes peak and context band without leaking non-rate fields", () => {
    // Both surcharges never apply together in the published catalog (step
    // models are not DeepSeek), but composition must stay correct if that
    // changes: band rates replace, peak scales them.
    const composed = resolveOpenCodeGoPricing("claude-haiku-5-5", { promptTokens: 150_000 });
    expect(composed).toMatchObject({ input: 0.5, output: 2.5, cached: 0.05 });
    expect(composed).not.toHaveProperty("above");
  });

  it("returns null for unknown models and computes cost through the resolver", () => {
    expect(resolveOpenCodeGoPricing("not-a-go-model")).toBeNull();
    // getPricingForModel must serve the opencode-go table (off-peak base).
    expect(getPricingForModel("opencode-go", "deepseek-v4-pro")).toMatchObject({ input: 0.66, output: 1.98 });
    expect(getPricingForModel("opencode-go", "deepseek-v4-pro")).not.toHaveProperty("usedUsd");
    const base = getPricingForModel("opencode-go", "deepseek-v4-pro");
    const peak = resolveOpenCodeGoPricing("deepseek-v4-pro", { at: weekdayPeak });
    expect(calculateCostFromTokens(deepseekPro, peak)).toBeCloseTo(2 * calculateCostFromTokens(deepseekPro, base), 5);
  });

  it("prices the free limited-time models at zero", () => {
    for (const model of ["beam-free", "longcat-2.5-free", "hy4-flash-free", "iceman-contributor-free"]) {
      expect(resolveOpenCodeGoPricing(model)).toEqual({ input: 0, output: 0, cached: 0, reasoning: 0 });
      expect(calculateCostFromTokens(deepseekPro, resolveOpenCodeGoPricing(model))).toBe(0);
    }
  });
});
