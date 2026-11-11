import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProviderConnectionById: vi.fn(), getModelSyncSnapshot: vi.fn(), addCustomModel: vi.fn(), refresh: vi.fn(), catalog: vi.fn() }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getProviderConnectionById, addCustomModel: mocks.addCustomModel, getCustomModels: vi.fn(), deleteCustomModel: vi.fn(), upsertModelCapabilities: vi.fn() }));
vi.mock("@/lib/db/repos/modelSyncRepo.js", () => ({ getModelSyncSnapshot: mocks.getModelSyncSnapshot, getModelSyncSnapshots: vi.fn() }));
vi.mock("@/lib/modelCapabilityOverrides", () => ({ refreshModelCapabilityOverrides: mocks.refresh }));
vi.mock("@/shared/utils/modelCatalog", () => ({ fetchModelsDevCatalog: mocks.catalog, lookupModelInCatalog: () => null, normalizeModelCapabilities: vi.fn() }));
const { POST } = await import("@/app/api/models/custom/route.js");
const request = (body) => new Request("http://localhost/api/models/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const input = { providerAlias: "cx", id: "account-model-image", type: "image", connectionId: "a" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue({ id: "a", provider: "codex", isActive: true });
  mocks.getModelSyncSnapshot.mockResolvedValue({ providerId: "codex", status: "success", source: "official", scope: "account", connectionId: "a", modelIds: ["account-model"] });
  mocks.addCustomModel.mockResolvedValue(true);
});
describe("Codex image configuration API", () => {
  it("accepts a local image route backed by the selected account's directory", async () => {
    expect((await POST(request(input))).status).toBe(200);
    expect(mocks.addCustomModel).toHaveBeenCalledWith(expect.objectContaining({ id: "account-model-image", type: "image" }));
  });
  it.each([{ id: "gpt-not-listed-image" }, { connectionId: "b" }, { connectionId: undefined }])("rejects unsupported or unselected account: %j", async (override) => {
    expect((await POST(request({ ...input, ...override }))).status).toBe(400);
    expect(mocks.addCustomModel).not.toHaveBeenCalled();
  });
  it.each([{ provider: "openai" }, { provider: "codex", isActive: false }])("rejects invalid connection: %j", async (connection) => {
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    expect((await POST(request(input))).status).toBe(400);
  });
  it("does not change other image providers", async () => {
    expect((await POST(request({ providerAlias: "openai", id: "image-model", type: "image" }))).status).toBe(200);
    expect(mocks.getModelSyncSnapshot).not.toHaveBeenCalled();
  });
});
