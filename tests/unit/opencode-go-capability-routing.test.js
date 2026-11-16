import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCapabilitiesForModel, replaceMeasuredCapabilityOverrides, replaceModelCapabilityOverrides } from "open-sse/providers/capabilities.js";
import { detectRequiredCapabilities, handleComboChat } from "open-sse/services/combo.js";

const state = vi.hoisted(() => ({ models: [] }));
vi.mock("@/lib/localDb", () => ({
  getCustomModels: async () => state.models,
  getProviderNodes: async () => [],
  getProviderConnections: async () => [],
}));
vi.mock("@/lib/db/repos/modelCapabilityTestsRepo.js", () => ({ getModelCapabilityTests: async () => [] }));
const { refreshModelCapabilityOverrides } = await import("@/lib/modelCapabilityOverrides.js");

const goModel = "deepseek-v4.1-flash";
const members = [`ocg/${goModel}`, "qd/dfmodel", "qdcn/dfmodel", "ds/deepseek-flash"];
const toolHistory = {
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "test", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "OK" }] },
  ],
};

beforeEach(() => {
  // Existing persisted Go rows retain the public directory's object-shaped
  // features, plus an independent manual vision override.
  const declaredCapabilities = { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high", "max"] } };
  state.models = [{
    providerId: "opencode-go", providerAlias: "ocg", id: goModel, source: "official",
    declaredCapabilities, capabilities: declaredCapabilities, manualCapabilities: { vision: true },
  }];
});
afterEach(() => {
  replaceModelCapabilityOverrides([]);
  replaceMeasuredCapabilityOverrides({});
});

async function dispatch(body, failFirst = false) {
  const attempts = [];
  const response = await handleComboChat({
    body, models: members, comboName: "deepseek-flash", comboStrategy: "fallback",
    log: { info: vi.fn(), warn: vi.fn() },
    handleSingleModel: async (_body, model) => {
      attempts.push(model);
      return failFirst && attempts.length === 1
        ? new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 })
        : new Response("OK", { status: 200 });
    },
  });
  expect(response.status).toBe(200);
  return attempts;
}

describe("OpenCode Go synchronized capabilities and combo routing", () => {
  it("normalizes existing official metadata for both provider names without rewriting it", async () => {
    await refreshModelCapabilityOverrides({ force: true });
    for (const provider of ["opencode-go", "ocg"]) {
      expect(getCapabilitiesForModel(provider, goModel)).toMatchObject({ tools: true, reasoning: true, vision: true });
    }
    expect(state.models[0].declaredCapabilities.tools).toEqual({ supported: true });
    expect(state.models[0].declaredCapabilities.reasoning.effort).toEqual(["low", "high", "max"]);
  });

  it.each([
    ["plain text", { messages: [{ role: "user", content: "Hello" }] }],
    ["tool history", toolHistory],
    ["forced tools", { messages: [{ role: "user", content: "Hello" }], tool_choice: "required" }],
  ])("keeps Go first for %s with auto-switch enabled", async (_name, body) => {
    await refreshModelCapabilityOverrides({ force: true });
    expect(await dispatch(body)).toEqual([members[0]]);
  });

  it("still falls back after a real Go upstream failure", async () => {
    await refreshModelCapabilityOverrides({ force: true });
    expect(await dispatch(toolHistory, true)).toEqual([members[0], members[1]]);
  });

  it("honors an explicit unsupported feature rather than treating its object as truthy", async () => {
    state.models[0].declaredCapabilities.tools.supported = false;
    await refreshModelCapabilityOverrides({ force: true });
    expect(getCapabilitiesForModel("ocg", goModel).tools).toBe(false);
    expect(await dispatch(toolHistory)).toEqual([members[1]]);
  });

  it("preserves a manual tools=false override above upstream supported=true", async () => {
    state.models[0].manualCapabilities.tools = false;
    await refreshModelCapabilityOverrides({ force: true });
    expect(getCapabilitiesForModel("ocg", goModel).tools).toBe(false);
    expect(await dispatch(toolHistory)).toEqual([members[1]]);
    expect(detectRequiredCapabilities(toolHistory).has("tools")).toBe(true);
  });
});
