import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real consumers and SQLite repos without touching a user's DB.
// Official discovery, including optional capability metadata, is fetch-stubbed.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let createProviderConnection;
let createCombo;
let addCustomModel;
let upsertModelCapabilities;
let recordModelSyncSnapshot;
let GET;
let buildModelsList;
let publicGET;
let fetchMock;
let syncPOST;
let resetModelsDevCatalogCache;

const providerRows = (models, provider) => models.filter((model) => model.owned_by === provider);

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-official-model-consumers-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: { json: (body, init = {}) => Response.json(body, { status: init.status || 200 }) },
  }));
  vi.doMock("@/lib/redis/hotCache.js", () => ({
    getHotJson: vi.fn(async () => null),
    setHotJson: vi.fn(async () => true),
    fillHotJson: vi.fn(async () => true),
    deleteHotJson: vi.fn(async () => true),
    incrementHotCounter: vi.fn(async () => 1),
  }));
  // Avoid traffic-accounting timers unrelated to the models contract.
  vi.doMock("@/lib/networkTraffic.js", () => ({
    withNetworkTraffic: (request, handler) => handler(request),
  }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  ({ createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js"));
  ({ createCombo } = await import("@/lib/db/repos/combosRepo.js"));
  ({ addCustomModel, upsertModelCapabilities } = await import("@/lib/db/repos/aliasRepo.js"));
  ({ recordModelSyncSnapshot } = await import("@/lib/db/repos/modelSyncRepo.js"));
  ({ GET } = await import("@/app/api/models/route.js"));
  ({ buildModelsList, GET: publicGET } = await import("@/app/api/v1/models/route.js"));
  ({ POST: syncPOST } = await import("@/app/api/providers/model-sync/route.js"));
  ({ resetModelsDevCatalogCache } = await import("@/shared/utils/modelCatalog.js"));
  db = await (await import("@/lib/db/driver.js")).getAdapter();
});

beforeEach(async () => {
  db.run("DELETE FROM providerConnections");
  db.run("DELETE FROM combos");
  db.run("DELETE FROM providerNodes");
  db.run("DELETE FROM kv");
  resetModelsDevCatalogCache();
  fetchMock.mockReset().mockRejectedValue(new Error("Unexpected external request in official model consumers test"));
  await (await import("@/lib/db/repos/settingsRepo.js")).updateSettings({ requireApiKey: false });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db?.close?.();
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe.each([["qoder", "cn"], ["qoder-cn", "global"]])("regional live catalog %s", (provider, region) => {
  it("never sends a mismatched credential to the network", async () => {
    await createProviderConnection({ provider, authType: "apikey", name: "Region isolation", apiKey: "pt-fixture", providerSpecificData: { region } });
    await buildModelsList(["llm"], { includeProviderModels: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function seedSyncedProvider(providerId, providerAlias) {
  const connection = await createProviderConnection({
    provider: providerId, authType: "apikey", name: "Isolated consumer test", apiKey: "test-only-model-key",
  });
  await addCustomModel({ providerAlias, id: "manual-model", name: "Manually retained" });
  // A stale static row and metadata-only row must not become routed models when
  // the official snapshot is authoritative, even if capability metadata remains.
  await (await import("@/lib/db/repos/aliasRepo.js")).syncCustomModels([
    { providerId, providerAlias, id: "retired-static-model", source: "static" },
    { providerId, providerAlias, id: "retired-official-model", source: "official" },
  ]);
  await upsertModelCapabilities({
    providerId, providerAlias, id: "capability-only-model", capabilities: { vision: true },
  });
  const directoryUrl = providerId === "deepseek"
    ? "https://api.deepseek.com/models" : "https://api.venice.ai/api/v1/models";
  fetchMock.mockImplementation(async (url) => {
    if (url === directoryUrl) return Response.json({ data: [{ id: "current-official-model", name: "Current Official" }] });
    if (url === "https://models.dev/api.json") return Response.json({});
    throw new Error(`Unexpected external URL in official model consumers test: ${url}`);
  });
  const response = await syncPOST(new Request("http://localhost/api/providers/model-sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, connectionId: connection.id }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, officialCount: 1, staticCount: 0 });
  // From here all consumers must use the persisted authoritative directory.
  fetchMock.mockClear().mockRejectedValue(new Error("Consumers must not fetch external model directories"));
  return connection;
}

describe("official model consumer boundaries", () => {
  it.each([
    ["deepseek", "ds"],
    ["venice", "venice"],
  ])("does not rehydrate static or capability-only %s models in dashboard/internal consumers", async (providerId, alias) => {
    const { usesUpstreamModelList } = await import("@/shared/constants/providers.js");
    const { getModelsByProviderId } = await import("open-sse/config/providerModels.js");
    expect(usesUpstreamModelList(providerId)).toBe(false);
    expect(getModelsByProviderId(providerId).length).toBeGreaterThan(0);
    await seedSyncedProvider(providerId, alias);
    const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
    expect((await getCustomModels()).find((model) => model.id === "capability-only-model"))
      .toMatchObject({ origin: "capability-override", capabilities: { vision: true } });

    const dashboardResponse = await GET(new Request("http://localhost/api/models"));
    expect(dashboardResponse.status).toBe(200);
    const dashboardModels = (await dashboardResponse.json()).models;
    expect(dashboardModels.filter((model) => [providerId, alias].includes(model.provider)).map((model) => model.model).sort())
      .toEqual(["current-official-model", "manual-model"]);

    const internalModels = await buildModelsList(["llm"], {
      skipDynamicFetch: true,
      includeProviderModels: true,
    });
    expect(providerRows(internalModels, alias).map((model) => model.id).sort())
      .toEqual([`${alias}/current-official-model`, `${alias}/manual-model`]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps public v1 models combos-only even with official provider snapshots", async () => {
    await seedSyncedProvider("deepseek", "ds");
    await createCombo({ name: "published-route", models: ["ds/current-official-model"] });
    await createCombo({ name: "paused-route", models: ["ds/manual-model"], isActive: false });

    const publicModels = await buildModelsList(["llm"]);
    expect(publicModels).toEqual([
      { id: "published-route", object: "model", owned_by: "combo", is_combo: true },
    ]);
    expect(publicModels.some((model) => model.id.includes("deepseek") || model.id.startsWith("ds/"))).toBe(false);
    const response = await publicGET(new Request("http://localhost/v1/models"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: "list", data: publicModels });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("model-sync snapshot database backup contract", () => {
  it("round-trips official snapshots through db export/import", async () => {
    await seedSyncedProvider("deepseek", "ds");
    await seedSyncedProvider("venice", "venice");
    const { exportDb, importDb } = await import("@/lib/db/index.js");

    const exported = await exportDb();
    expect(exported.modelSyncSnapshots).toMatchObject({
      deepseek: { providerId: "deepseek", providerAlias: "ds", status: "success", source: "official", modelIds: ["current-official-model"] },
      venice: { providerId: "venice", providerAlias: "venice", status: "success", source: "official", scope: "public", modelIds: ["current-official-model"] },
    });

    // Import replaces the DB. Compare the snapshot payload after the roundtrip,
    // while ensuring the current repo reads it from the dedicated KV scope.
    await recordModelSyncSnapshot({
      providerId: "other-provider", providerAlias: "other", connectionId: "not-in-backup", scope: "account", models: ["stale-model"],
    });
    const restored = await importDb(JSON.parse(JSON.stringify(exported)));
    expect(restored.modelSyncSnapshots).toEqual(exported.modelSyncSnapshots);
    expect(restored.modelSyncSnapshots).not.toHaveProperty("other-provider");
    expect(restored.customModels).toEqual(exported.customModels);
    const { getModelSyncSnapshots } = await import("@/lib/db/repos/modelSyncRepo.js");
    expect(await getModelSyncSnapshots()).toEqual(exported.modelSyncSnapshots);
    const internalModels = await buildModelsList(["llm"], { includeProviderModels: true, skipDynamicFetch: true });
    for (const alias of ["ds", "venice"]) {
      expect(providerRows(internalModels, alias).map((model) => model.id).sort())
        .toEqual([`${alias}/current-official-model`, `${alias}/manual-model`]);
    }
  });

  it("clears snapshots absent from an older imported backup rather than retaining current markers", async () => {
    await seedSyncedProvider("deepseek", "ds");
    const { exportDb, importDb, getModelSyncSnapshots } = await import("@/lib/db/index.js");
    const backup = await exportDb();
    delete backup.modelSyncSnapshots;
    const restored = await importDb(backup);
    expect(restored.modelSyncSnapshots).toEqual({});
    expect(await getModelSyncSnapshots()).toEqual({});
  });
});

describe("channel-level model-sync snapshot cleanup", () => {
  it("keeps a shared provider snapshot until the last connection is deleted", async () => {
    const first = await seedSyncedProvider("deepseek", "ds");
    const second = await createProviderConnection({ provider: "deepseek", authType: "apikey", apiKey: "test-only-second-key" });
    const unrelated = await createProviderConnection({ provider: "venice", authType: "apikey", apiKey: "test-only-other-key" });
    await recordModelSyncSnapshot({ providerId: "venice", providerAlias: "venice", connectionId: unrelated.id, scope: "public", models: ["other-model"] });
    const { deleteProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    const { getModelSyncSnapshot } = await import("@/lib/db/repos/modelSyncRepo.js");
    const snapshot = await getModelSyncSnapshot("deepseek");

    expect(await deleteProviderConnection(first.id)).toBe(true);
    expect(await getModelSyncSnapshot("deepseek")).toEqual(snapshot);
    expect(await deleteProviderConnection(second.id)).toBe(true);
    expect(await getModelSyncSnapshot("deepseek")).toBeNull();
    expect(await getModelSyncSnapshot("venice")).toMatchObject({ modelIds: ["other-model"] });
  });

  it("clears the provider snapshot when all of its connections are deleted", async () => {
    await seedSyncedProvider("deepseek", "ds");
    await createProviderConnection({ provider: "deepseek", authType: "apikey", apiKey: "test-only-second-key" });
    const { deleteProviderConnectionsByProvider } = await import("@/lib/db/repos/connectionsRepo.js");
    const { getModelSyncSnapshot } = await import("@/lib/db/repos/modelSyncRepo.js");
    expect(await deleteProviderConnectionsByProvider("deepseek")).toBe(2);
    expect(await getModelSyncSnapshot("deepseek")).toBeNull();
  });

  it("clears a deleted compatible node snapshot even when it has no model rows or connections", async () => {
    const { createProviderNode, deleteProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
    const { getModelSyncSnapshot } = await import("@/lib/db/repos/modelSyncRepo.js");
    const node = await createProviderNode({ id: "openai-compatible-snapshot-only", type: "openai-compatible", name: "Snapshot-only test", prefix: "isolated-prefix" });
    await recordModelSyncSnapshot({ providerId: node.id, providerAlias: node.id, connectionId: "deleted-connection", scope: "account", models: ["listed-model"] });
    expect((await deleteProviderNode(node.id)).id).toBe(node.id);
    expect(await getModelSyncSnapshot(node.id)).toBeNull();
  });

  it("purges the canonical provider snapshot by its storage alias without affecting other channels", async () => {
    await recordModelSyncSnapshot({ providerId: "deepseek", providerAlias: "ds", connectionId: "isolated-connection", scope: "account", models: ["listed-model"] });
    await recordModelSyncSnapshot({ providerId: "venice", providerAlias: "venice", connectionId: "other-connection", scope: "public", models: ["other-model"] });
    const { purgeChannelModelRows } = await import("@/lib/db/modelCleanup.js");
    const { getModelSyncSnapshots } = await import("@/lib/db/repos/modelSyncRepo.js");
    await purgeChannelModelRows(["ds"]);
    const snapshots = await getModelSyncSnapshots();
    expect(snapshots).not.toHaveProperty("deepseek");
    expect(snapshots.venice).toMatchObject({ modelIds: ["other-model"] });
  });
});
