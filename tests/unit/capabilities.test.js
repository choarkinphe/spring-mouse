import { afterEach, describe, expect, it } from "vitest";
import { getCapabilitiesForModel, getMeasuredCapabilitiesForConnection, replaceMeasuredCapabilityOverrides, replaceModelCapabilityOverrides } from "../../open-sse/providers/capabilities.js";

afterEach(() => {
  replaceModelCapabilityOverrides([]);
  replaceMeasuredCapabilityOverrides({});
});

describe("getCapabilitiesForModel", () => {
  const claudeSonnet5Expected = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  const kiroGpt56Expected = {
    contextWindow: 272000,
    maxOutput: 128000,
    thinkingFormat: "openai",
    reasoning: true,
    vision: true,
    search: true,
  };

  it("reports Kiro Claude Opus 5 variants as 1M adaptive-thinking models", () => {
    for (const model of [
      "claude-opus-5",
      "anthropic/claude-opus-5",
      "claude-opus-5-thinking",
      "claude-opus-5-agentic",
      "claude-opus-5-thinking-agentic",
    ]) {
      expect(getCapabilitiesForModel("kiro", model)).toMatchObject(claudeSonnet5Expected);
    }
  });

  it("reports Kiro Claude Opus 4.8 as a 1M context model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8-thinking").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8-thinking").contextWindow).toBe(1000000);
  });

  it("reports Kiro Claude Sonnet 5 as a 1M adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-agentic")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking-agentic")).toMatchObject(claudeSonnet5Expected);
  });

  it("reports Kiro GPT 5.6 models with the Kiro 272k context window", () => {
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "openai/gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-terra-thinking")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-luna-agentic")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol-thinking-agentic")).toMatchObject(kiroGpt56Expected);
  });

  it("reports GLM 5.3 Flash as a native multimodal model", () => {
    expect(getCapabilitiesForModel("glm-cn", "glm-5.3-flash")).toMatchObject({
      vision: true,
      pdf: true,
      videoInput: true,
      reasoning: true,
      contextWindow: 1000000,
      maxOutput: 131072,
    });
  });

  it("resolves provider-specific capabilities through the provider alias", () => {
    for (const model of [
      "glm-5.2",
      "glm-5v-turbo",
      "minimax-m2.7",
      "hy3-preview",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]) {
      expect(getCapabilitiesForModel("cbcn", model)).toEqual(
        getCapabilitiesForModel("codebuddy-cn", model),
      );
    }

    expect(getCapabilitiesForModel("cbcn", "glm-5v-turbo").vision).toBe(true);
    expect(getCapabilitiesForModel("cbcn", "glm-5.2")).toMatchObject({
      contextWindow: 1000000,
      thinkingFormat: "openai",
    });
  });

  it.each(["qwen3.8-flash", "Qwen/Qwen3.8-Flash", "qwen3.8-flash-2026-08-26"])("recognizes %s as vision-capable on custom channels", (model) => {
    expect(getCapabilitiesForModel("openai-compatible-responses-custom", model)).toMatchObject({
      vision: true, reasoning: true, thinkingFormat: "qwen",
    });
  });

  it("keeps Qwen coder models text-only and respects explicit channel overrides", () => {
    expect(getCapabilitiesForModel("custom", "qwen3-coder-flash").vision).toBe(false);
    replaceModelCapabilityOverrides([{ provider: "custom", model: "qwen3.8-flash", capabilities: { vision: false } }]);
    expect(getCapabilitiesForModel("custom", "qwen3.8-flash").vision).toBe(false);
  });

  it.each([true, false])("normalizes supported=%s feature objects without changing runtime metadata", (supported) => {
    const capabilities = {
      tools: { supported }, reasoning: { supported, effort: ["high"] },
      vision: { supported }, thinkingCanDisable: { supported },
      contextWindow: 1000000, maxOutput: 384000,
      thinkingFormat: "openai", thinkingRange: { min: 1, max: 100 },
    };
    replaceModelCapabilityOverrides([{ provider: "opencode-go", model: "test-model", capabilities }]);
    expect(getCapabilitiesForModel("ocg", "test-model")).toMatchObject({
      tools: supported, reasoning: supported, vision: supported, thinkingCanDisable: supported,
      contextWindow: 1000000, maxOutput: 384000,
      thinkingFormat: "openai", thinkingRange: { min: 1, max: 100 },
    });
    expect(capabilities.tools).toEqual({ supported });
  });

  it("ignores malformed feature values rather than overriding known capabilities", () => {
    replaceModelCapabilityOverrides([{
      provider: "custom", model: "qwen3.8-flash",
      capabilities: { tools: { supported: "false" }, vision: null, reasoning: {}, pdf: 1, search: "true" },
    }]);
    expect(getCapabilitiesForModel("custom", "qwen3.8-flash")).toMatchObject({
      tools: true, vision: true, reasoning: true, pdf: false, search: false,
    });
  });

  it("normalizes measured and manual layers while preserving their precedence", () => {
    replaceModelCapabilityOverrides([{ provider: "opencode-go", model: "test-model", capabilities: { tools: { supported: true } } }]);
    replaceMeasuredCapabilityOverrides({
      connections: [{ provider: "opencode-go", model: "test-model", connectionId: "account", capabilities: { tools: { supported: false } } }],
      channels: [{ provider: "opencode-go", model: "test-model", capabilities: { tools: { supported: false } } }],
    });
    expect(getCapabilitiesForModel("ocg", "test-model").tools).toBe(false);
    expect(getCapabilitiesForModel("ocg", "test-model", { connectionId: "account" }).tools).toBe(false);
    expect(getMeasuredCapabilitiesForConnection("ocg", "test-model", "account").tools).toBe(false);
    replaceMeasuredCapabilityOverrides({
      connections: [{ provider: "opencode-go", model: "test-model", connectionId: "account", capabilities: { tools: false } }],
      channels: [{ provider: "opencode-go", model: "test-model", capabilities: { tools: false } }],
      manual: [{ provider: "opencode-go", model: "test-model", capabilities: { tools: { supported: true } } }],
    });
    expect(getCapabilitiesForModel("ocg", "test-model").tools).toBe(true);
    expect(getMeasuredCapabilitiesForConnection("ocg", "test-model", "account").tools).toBe(true);
  });

  it("merges synchronized metadata over static family defaults", () => {
    replaceModelCapabilityOverrides([{
      provider: "glm-cn",
      model: "glm-future-flash",
      capabilities: { vision: true, pdf: true, contextWindow: 500000 },
    }]);

    expect(getCapabilitiesForModel("glm-cn", "glm-future-flash")).toMatchObject({
      vision: true,
      pdf: true,
      reasoning: true,
      thinkingFormat: "zai",
      contextWindow: 500000,
    });
  });
});
