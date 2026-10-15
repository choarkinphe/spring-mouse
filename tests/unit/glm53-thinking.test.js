import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe.each(["glm", "glm-cn"])("%s GLM 5.3 reasoning", (provider) => {
  it.each([
    { thinking: { type: "disabled" } },
    { enable_thinking: false },
    { reasoning: { effort: "none" } },
  ])("maps disabled reasoning to the supported low effort", (input) => {
    const body = applyThinking("openai", "glm-5.3", structuredClone(input), provider);
    expect(body).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
  });
  it.each([["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "max"], ["max", "max"]])("preserves/maps %s effort", (input, expected) => {
    const body = applyThinking("openai", "glm-5.3", { thinking: { type: "enabled" }, reasoning_effort: input }, provider);
    expect(body.reasoning_effort).toBe(expected);
    expect(body.thinking).toEqual({ type: "enabled" });
  });
  it("offers only supported levels and preserves the provider default when unspecified", () => {
    expect(getThinkingLevels(provider, "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(applyThinking("openai", "glm-5.3", {}, provider)).toEqual({});
    expect(applyThinking("openai", "glm-5.2", { enable_thinking: false }, provider)).toEqual({ enable_thinking: false });
  });
});
