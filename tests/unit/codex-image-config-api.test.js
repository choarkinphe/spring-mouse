import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProviderConnectionById: vi.fn(), getModelSyncSnapshot: vi.fn(), addCustomModel: vi.fn(), deleteCustomModel: vi.fn(), refresh: vi.fn(), catalog: vi.fn() }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getProviderConnectionById, addCustomModel: mocks.addCustomModel, getCustomModels: vi.fn(), deleteCustomModel: mocks.deleteCustomModel, upsertModelCapabilities: vi.fn() }));
vi.mock("@/lib/db/repos/modelSyncRepo.js", () => ({ getModelSyncSnapshot: mocks.getModelSyncSnapshot, getModelSyncSnapshots: vi.fn() }));
vi.mock("@/lib/modelCapabilityOverrides", () => ({ refreshModelCapabilityOverrides: mocks.refresh }));
vi.mock("@/shared/utils/modelCatalog", () => ({ fetchModelsDevCatalog: mocks.catalog, lookupModelInCatalog: () => null, normalizeModelCapabilities: vi.fn() }));
const { POST, DELETE } = await import("@/app/api/models/custom/route.js");
const request = (body) => new Request("http://localhost/api/models/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const input = { providerAlias: "cx", id: "gpt-image-2", type: "image", connectionId: "a" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue({ id: "a", provider: "codex", isActive: true });
  mocks.getModelSyncSnapshot.mockResolvedValue(null);
  mocks.addCustomModel.mockResolvedValue(true);
});
describe("Codex image configuration API", () => {
  it.each(["cx", "codex"])("accepts native images without a chat snapshot for %s", async (providerAlias) => {
    expect((await POST(request({ ...input, providerAlias }))).status).toBe(200);
    expect(mocks.addCustomModel).toHaveBeenCalledWith(expect.objectContaining({ providerAlias, id: "gpt-image-2", type: "image" }));
    expect(mocks.getModelSyncSnapshot).not.toHaveBeenCalled();
    expect(mocks.deleteCustomModel).not.toHaveBeenCalled();
  });
  it.each([{ id: "gpt-not-listed-image" }, { id: "account-model-image" }, { id: "gpt-image-99" }, { connectionId: "b" }, { connectionId: undefined }, { connectionId: "" }])("rejects unsupported models or unselected accounts: %j", async (override) => {
    expect((await POST(request({ ...input, ...override }))).status).toBe(400);
    expect(mocks.addCustomModel).not.toHaveBeenCalled();
  });
  it.each([null, { id: "a", provider: "openai" }, { id: "a", provider: "codex", isActive: false }])("rejects invalid connections: %j", async (connection) => {
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    expect((await POST(request(input))).status).toBe(400);
    expect(mocks.addCustomModel).not.toHaveBeenCalled();
  });
  it("does not treat a chat directory model as image entitlement", async () => {
    mocks.getModelSyncSnapshot.mockResolvedValue({ providerId: "codex", status: "success", source: "official", scope: "account", connectionId: "a", modelIds: ["account-model"] });
    expect((await POST(request({ ...input, id: "account-model-image" }))).status).toBe(400);
    expect(mocks.getModelSyncSnapshot).not.toHaveBeenCalled();
    expect(mocks.addCustomModel).not.toHaveBeenCalled();
  });
  it("allows explicit removal of a legacy alias without image entitlement checks", async () => {
    const response = await DELETE(new Request("http://localhost/api/models/custom?providerAlias=cx&id=account-model-image&type=image", { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(mocks.deleteCustomModel).toHaveBeenCalledWith({ providerAlias: "cx", id: "account-model-image", type: "image" });
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
  });
  it("does not change other image providers", async () => {
    expect((await POST(request({ providerAlias: "openai", id: "image-model", type: "image" }))).status).toBe(200);
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
    expect(mocks.getModelSyncSnapshot).not.toHaveBeenCalled();
  });
});
