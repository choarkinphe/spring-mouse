import { beforeEach, describe, expect, it, vi } from "vitest";

// A compatible channel's model rows are keyed by its provider node id, but a
// combo addresses the same model by the channel's display prefix ("千问API").
// The override table has to carry both forms or a model the user marked
// vision-capable reads as text-only through a combo string.
const NODE_ID = "openai-compatible-chat-b709e32c-094a-4c75-9cf7-4dec795f57b0";
const NODE_PREFIX = "千问API";
const VISION_MODEL = "deepseek-v4-flash-0731";

const state = vi.hoisted(() => ({
  customModels: [],
  providerNodes: [],
  providerConnections: [],
}));

vi.mock("@/lib/localDb", () => ({
  getCustomModels: async () => state.customModels,
  getProviderNodes: async () => state.providerNodes,
  getProviderConnections: async () => state.providerConnections,
}));

const { refreshModelCapabilityOverrides } = await import("../../src/lib/modelCapabilityOverrides.js");
const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
const {
  getComboCapabilityValidationError,
  getComboModelsForRequest,
  getUnsupportedComboRequestCapability,
} = await import("../../open-sse/services/combo.js");

const comboEntry = `${NODE_PREFIX}/${VISION_MODEL}`;
const visionCapabilities = { contextWindow: null, vision: true, audioInput: false };

beforeEach(() => {
  state.customModels = [];
  state.providerNodes = [];
  state.providerConnections = [];
});

describe("model capability overrides resolve a channel's display prefix", () => {
  it("exposes a node-hosted model's vision capability under the combo prefix", async () => {
    state.customModels = [{
      providerAlias: NODE_ID,
      providerId: NODE_ID,
      id: VISION_MODEL,
      capabilities: { vision: true },
    }];
    state.providerNodes = [{ id: NODE_ID, type: "openai-compatible", prefix: NODE_PREFIX }];

    await refreshModelCapabilityOverrides({ force: true });

    // The combo string addresses the model by the prefix, not the node id.
    expect(getCapabilitiesForModel(NODE_PREFIX, VISION_MODEL).vision).toBe(true);
    // The node-id form must keep working for direct (non-combo) calls.
    expect(getCapabilitiesForModel(NODE_ID, VISION_MODEL).vision).toBe(true);
  });

  it("lets a combo declare vision when its member is reachable only by prefix", async () => {
    state.customModels = [{
      providerAlias: NODE_ID,
      providerId: NODE_ID,
      id: VISION_MODEL,
      capabilities: { vision: true },
    }];
    state.providerNodes = [{ id: NODE_ID, type: "openai-compatible", prefix: NODE_PREFIX }];

    await refreshModelCapabilityOverrides({ force: true });

    // Saving the combo and serving an image request must agree, and both used to
    // fail with "组合声明支持视觉，但没有添加支持视觉的模型节点".
    expect(getComboCapabilityValidationError([comboEntry], visionCapabilities)).toBeNull();
    expect(getUnsupportedComboRequestCapability(new Set(["vision"]), visionCapabilities)).toBeNull();
    expect(getComboModelsForRequest([comboEntry], new Set(["vision"]), visionCapabilities)).toEqual([comboEntry]);
  });

  it("picks the prefix up from a connection's providerSpecificData", async () => {
    state.customModels = [{
      providerAlias: NODE_ID,
      providerId: NODE_ID,
      id: VISION_MODEL,
      capabilities: { vision: true },
    }];
    state.providerConnections = [{
      provider: NODE_ID,
      providerSpecificData: { prefix: NODE_PREFIX },
    }];

    await refreshModelCapabilityOverrides({ force: true });

    expect(getCapabilitiesForModel(NODE_PREFIX, VISION_MODEL).vision).toBe(true);
  });

  it("does not let a prefix shadow a built-in provider", async () => {
    // A node whose prefix collides with the built-in "ds" alias must not inject
    // its channel's capabilities into the built-in provider's models.
    state.customModels = [{
      providerAlias: "openai-compatible-chat-shadow",
      providerId: "openai-compatible-chat-shadow",
      id: "deepseek-v4-pro",
      capabilities: { vision: true },
    }];
    state.providerNodes = [{ id: "openai-compatible-chat-shadow", type: "openai-compatible", prefix: "ds" }];

    await refreshModelCapabilityOverrides({ force: true });

    // Built-in ds/deepseek-v4-pro is text-only; the shadowing node must not flip it.
    expect(getCapabilitiesForModel("ds", "deepseek-v4-pro").vision).toBe(false);
    // The node's own id form still carries the override.
    expect(getCapabilitiesForModel("openai-compatible-chat-shadow", "deepseek-v4-pro").vision).toBe(true);
  });

  it("keeps a model without capabilities out of the override table", async () => {
    state.customModels = [
      { providerAlias: NODE_ID, providerId: NODE_ID, id: "deepseek-v4-pro-0813", capabilities: {} },
      { providerAlias: NODE_ID, providerId: NODE_ID, id: VISION_MODEL, capabilities: { vision: true } },
    ];
    state.providerNodes = [{ id: NODE_ID, type: "openai-compatible", prefix: NODE_PREFIX }];

    await refreshModelCapabilityOverrides({ force: true });

    expect(getCapabilitiesForModel(NODE_PREFIX, "deepseek-v4-pro-0813").vision).toBe(false);
    expect(getCapabilitiesForModel(NODE_PREFIX, VISION_MODEL).vision).toBe(true);
  });
});
