import { beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityFingerprint } from "@/lib/modelCapabilities/evidence.js";
const state = vi.hoisted(() => ({ models: [], nodes: [], accounts: [], profiles: [] }));
vi.mock("@/lib/localDb", () => ({
  getCustomModels: async () => state.models,
  getProviderNodes: async () => state.nodes,
  getProviderConnections: async () => state.accounts,
}));
vi.mock("@/lib/db/repos/modelCapabilityTestsRepo.js", () => ({ getModelCapabilityTests: async () => state.profiles }));
const { refreshModelCapabilityOverrides } = await import("@/lib/modelCapabilityOverrides.js");
const { getCapabilitiesForModel, getMeasuredCapabilitiesForConnection } = await import("open-sse/providers/capabilities.js");
const { getComboModelsForRequest, detectRequiredCapabilities } = await import("open-sse/services/combo.js");
const provider = "openai-compatible-chat-measure";
const model = "vendor/unknown";
const evidence = (account, value) => {
  const fingerprint = capabilityFingerprint(account, model);
  return { providerId: provider, connectionId: account.id, modelId: model, fingerprint, evidence: { vision: { status: value ? "supported" : "unsupported", fingerprint, probeVersion: 1, testedAt: new Date().toISOString() } } };
};
beforeEach(() => {
  state.models = [{ providerId: provider, providerAlias: provider, id: model, source: "official", capabilities: { vision: true } }];
  state.nodes = [{ id: provider, prefix: "实测渠道" }];
  state.accounts = [{ id: "a", provider }, { id: "b", provider }];
  state.profiles = [];
});
describe("connection-scoped measured capability routing", () => {
  it("keeps supported and unsupported accounts separate and resolves channel prefixes", async () => {
    state.profiles = [evidence(state.accounts[0], false), evidence(state.accounts[1], true)];
    await refreshModelCapabilityOverrides({ force: true });
    expect(getMeasuredCapabilitiesForConnection(provider, model, "a").vision).toBe(false);
    expect(getMeasuredCapabilitiesForConnection(provider, model, "b").vision).toBe(true);
    expect(getCapabilitiesForModel("实测渠道", model).vision).toBe(true);
    expect(getCapabilitiesForModel(provider, model, { connectionId: "a" }).vision).toBe(false);
    expect(getCapabilitiesForModel("different-channel", model).vision).toBe(false);
  });
  it("only disables channel-wide vision once every account explicitly rejects it", async () => {
    state.profiles = [evidence(state.accounts[0], false)];
    await refreshModelCapabilityOverrides({ force: true });
    expect(getCapabilitiesForModel(provider, model).vision).toBe(true);
    state.profiles.push(evidence(state.accounts[1], false));
    await refreshModelCapabilityOverrides({ force: true });
    expect(getCapabilitiesForModel(provider, model).vision).toBe(false);
  });
  it("honors explicit manual false above measured success and catalog true", async () => {
    state.models[0].manualCapabilities = { vision: false };
    state.profiles = [evidence(state.accounts[0], true)];
    await refreshModelCapabilityOverrides({ force: true });
    expect(getCapabilitiesForModel(provider, model).vision).toBe(false);
    expect(getMeasuredCapabilitiesForConnection(provider, model, "a").vision).toBe(false);
  });
  it("filters explicitly unsupported tool routes without blocking optional tools", async () => {
    state.models[0].manualCapabilities = { tools: false };
    await refreshModelCapabilityOverrides({ force: true });
    expect(detectRequiredCapabilities({ tools: [{ type: "function" }] }).has("tools")).toBe(false);
    const required = detectRequiredCapabilities({ tool_choice: "required" });
    expect(getComboModelsForRequest([`${provider}/${model}`, "other/model"], required, {})).toEqual(["other/model"]);
  });
  it("does not reuse an archive after an account key changes", async () => {
    state.profiles = [evidence(state.accounts[0], false)];
    state.accounts[0].apiKey = "new-key";
    await refreshModelCapabilityOverrides({ force: true });
    expect(getMeasuredCapabilitiesForConnection(provider, model, "a").vision).toBeUndefined();
  });
});
