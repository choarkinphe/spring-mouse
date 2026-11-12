import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connections: [], combos: [], custom: [], snapshots: {}, disabled: {}, settings: {}, tags: [], authFailure: null }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => mocks.connections,
  getCombos: async () => mocks.combos,
  getComboByName: async (name) => mocks.combos.find((combo) => combo.name === name),
  getCustomModels: async () => mocks.custom,
  getModelAliases: async () => ({}),
  getSettings: async () => mocks.settings,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => mocks.disabled }));
vi.mock("@/lib/db/repos/modelSyncRepo.js", () => ({ getModelSyncSnapshots: async () => mocks.snapshots }));
vi.mock("@/lib/networkTraffic.js", () => ({ withNetworkTraffic: (request, handler) => handler(request) }));
vi.mock("@/sse/services/auth.js", () => ({ authorizeApiKey: async () => mocks.authFailure, extractApiKey: () => "test-key", resolveApiKeyAccessTags: async () => mocks.tags }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));
const { GET, buildModelsList } = await import("@/app/api/v1/models/route.js");
const { GET: kindGET } = await import("@/app/api/v1/models/[kind]/route.js");
const nativeId = "cx/gpt-image-2";
const account = (extra = {}) => ({ id: "account-a", provider: "codex", isActive: true, ...extra });
const get = (headers = {}) => GET(new Request("http://localhost/v1/models", { headers }));
const imageList = () => kindGET(new Request("http://localhost/v1/models/image"), { params: Promise.resolve({ kind: "image" }) });
beforeEach(() => {
  Object.assign(mocks, { connections: [account()], combos: [], custom: [], snapshots: {}, disabled: {}, settings: {}, tags: [], authFailure: null });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Discovery must never call the upstream or generate images"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("native Codex image discovery", () => {
  it("publishes native image metadata in the default and image-specific APIs without manual rows", async () => {
    const expected = { id: nativeId, object: "model", owned_by: "cx", kind: "image", input_modalities: ["text"], output_modalities: ["image"], modalities: { input: ["text"], output: ["image"] } };
    const general = await (await get()).json();
    const images = await (await imageList()).json();
    expect(general.data).toHaveLength(1);
    expect(general.data[0]).toMatchObject(expected);
    expect(images.data).toEqual(general.data);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps explicit llm-only internal consumers unchanged", async () => {
    expect(await buildModelsList(["llm"])).toEqual([]);
  });
  it("preserves chat combos while excluding direct chat models and legacy image aliases", async () => {
    mocks.combos = [{ name: "chat-route", models: ["cx/gpt-chat"], isActive: true }];
    mocks.custom = [{ providerAlias: "cx", id: "gpt-5.5-image", type: "image" }];
    mocks.snapshots = { codex: { providerId: "codex", status: "success", source: "official", modelIds: ["gpt-chat"] } };
    const data = (await (await get()).json()).data;
    expect(data.map((row) => row.id)).toEqual(["chat-route", nativeId]);
    expect(data[0]).toEqual({ id: "chat-route", object: "model", owned_by: "combo", is_combo: true });
  });
  it.each([{ connections: [] }, { connections: [account({ isActive: false })] }, { connections: [account({ provider: "openai" })] }])("does not advertise Codex without an enabled Codex account: %j", async ({ connections }) => {
    mocks.connections = connections;
    expect((await (await get()).json()).data).toEqual([]);
  });
  it("deduplicates multiple accounts and manual rows without disclosing account details", async () => {
    mocks.connections.push(account({ id: "account-b", name: "private-name", accessToken: "private-token" }));
    mocks.custom = [{ providerAlias: "cx", id: "gpt-image-2", type: "image" }];
    const data = (await (await get()).json()).data;
    expect(data).toHaveLength(1);
    expect(JSON.stringify(data)).not.toMatch(/account-a|account-b|private-name|private-token/);
    const internal = await buildModelsList(["image"], { includeProviderModels: true, skipDynamicFetch: true });
    expect(internal.filter((row) => row.id === nativeId)).toHaveLength(1);
  });
  it.each(["cx", "codex"])("honors disabled model settings under %s", async (alias) => {
    mocks.disabled = { [alias]: ["gpt-image-2"] };
    expect((await (await get()).json()).data).toEqual([]);
    expect((await (await imageList()).json()).data).toEqual([]);
  });
  it.each(["cx/gpt-image-2", "codex/gpt-image-2", "gpt-image-2", "custom-codex/gpt-image-2"])("honors access tags under %s", async (id) => {
    mocks.connections = [account({ providerSpecificData: { prefix: "custom-codex" } })];
    mocks.settings = { modelAccessTags: { [id]: ["image-team"] } };
    mocks.tags = ["other-team"];
    expect((await (await get()).json()).data).toEqual([]);
    expect((await (await imageList()).json()).data).toEqual([]);
    mocks.tags = ["image-team"];
    expect((await (await get()).json()).data[0].id).toBe(nativeId);
  });
  it("retains the combo-only boundary and exposes image combo modality", async () => {
    mocks.settings = { comboOnlyRouting: { enabled: true } };
    mocks.combos = [{ name: "illustrator", kind: "image", models: [nativeId], isActive: true }];
    const data = (await (await get()).json()).data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: "illustrator", is_combo: true, kind: "image", output_modalities: ["image"], modalities: { output: ["image"] } });
    mocks.tags = ["god"];
    expect((await (await get()).json()).data.map((row) => row.id)).toEqual(["illustrator", nativeId]);
  });
  it("keeps restricted and inactive image combos hidden", async () => {
    mocks.combos = [
      { name: "private-image", kind: "image", models: [nativeId], accessTags: ["private"] },
      { name: "paused-image", kind: "image", models: [nativeId], isActive: false },
      { name: "empty-image", kind: "image", models: [] },
    ];
    expect((await (await get()).json()).data.map((row) => row.id)).toEqual([nativeId]);
  });
  it("leaves the Anthropic model envelope free of image-only entries", async () => {
    const response = await get({ "anthropic-version": "2023-06-01" });
    expect((await response.json()).data).toEqual([]);
  });
  it("does not bypass gateway key authentication", async () => {
    mocks.authFailure = Response.json({ error: "Unauthorized" }, { status: 401 });
    expect((await get()).status).toBe(401);
  });
});
