import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Integration tests over real isolated SQLite, not mocked repositories. All
// fetches (including optional capability metadata) are intercepted below.
const MODELS_URL = "https://api.openai.com/v1/models";
const METADATA_URL = "https://models.dev/api.json";
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let repo;
let snapshots;
let connections;
let visibility;
let resetCatalogCache;
let POST;
let connection;
let fetchMock;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const sync = (body = {}) => POST(new Request("http://localhost/api/providers/model-sync", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ providerId: "openai", connectionId: connection.id, ...body }),
}));
const stubDirectory = (payload, status = 200, metadata = {}) => fetchMock.mockImplementation(async (url) => {
  if (url === MODELS_URL) return jsonResponse(payload, status);
  if (url === METADATA_URL) return jsonResponse(metadata);
  throw new Error(`Unexpected external URL in model sync test: ${url}`);
});
const rawState = () => db.all("SELECT scope, key, value FROM kv WHERE scope IN ('customModels', 'modelSyncSnapshots') ORDER BY scope, key");
const seed = async () => {
  await repo.addCustomModel({ providerAlias: "openai", id: "manual-keep", name: "My manual model" });
  await repo.addCustomModel({ providerAlias: "openai", id: "manual-also-listed", name: "My chosen name" });
  await repo.syncCustomModels([
    ...["official", "static", "catalog", "models-dev"].map((source) => ({
      providerId: "openai", providerAlias: "openai", id: `old-${source}`, source,
    })),
    { providerId: "deepseek", providerAlias: "ds", id: "other-provider-model", source: "official" },
  ], {
    syncSnapshot: {
      providerId: "openai", providerAlias: "openai", connectionId: connection.id,
      scope: "account", models: [{ id: "old-official" }], syncedAt: "2025-01-01T00:00:00.000Z",
    },
  });
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-model-snapshots-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.doMock("next/server", () => ({ NextResponse: { json: (body, init = {}) => jsonResponse(body, init.status || 200) } }));
  vi.doMock("@/lib/redis/hotCache.js", () => ({
    getHotJson: vi.fn(async () => null), setHotJson: vi.fn(async () => true),
    fillHotJson: vi.fn(async () => true), deleteHotJson: vi.fn(async () => true),
    incrementHotCounter: vi.fn(async () => 1),
  }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  repo = await import("@/lib/db/repos/aliasRepo.js");
  snapshots = await import("@/lib/db/repos/modelSyncRepo.js");
  connections = await import("@/lib/db/repos/connectionsRepo.js");
  visibility = await import("@/shared/utils/providerCustomModels.js");
  ({ resetModelsDevCatalogCache: resetCatalogCache } = await import("@/shared/utils/modelCatalog.js"));
  ({ POST } = await import("@/app/api/providers/model-sync/route.js"));
  db = await (await import("@/lib/db/driver.js")).getAdapter();
});

beforeEach(async () => {
  db.run("DELETE FROM providerConnections");
  db.run("DELETE FROM kv");
  resetCatalogCache();
  fetchMock.mockReset().mockRejectedValue(new Error("Unexpected external request in model sync test"));
  connection = await connections.createProviderConnection({
    provider: "openai", authType: "apikey", name: "Isolated snapshot test", apiKey: "test-only-model-sync-key",
  });
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

describe("server-authoritative model synchronization", () => {
  it("ignores forged supportedModels and stores only the fresh server-fetched IDs", async () => {
    stubDirectory({ data: [{ id: "fresh-official-model" }] });
    const response = await sync({
      officialFetched: true, supportedModels: [{ id: "client-forged-model" }], models: [{ id: "also-forged" }],
      discovery: { status: "success", source: "official", scope: "public" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, total: 1, officialCount: 1, staticCount: 0 });
    expect((await repo.getCustomModels()).map((model) => model.id)).toEqual(["fresh-official-model"]);
    expect(fetchMock.mock.calls.filter(([url]) => url === MODELS_URL)).toHaveLength(1);
    expect(await snapshots.getModelSyncSnapshot("openai")).toMatchObject({
      providerId: "openai", providerAlias: "openai", connectionId: connection.id,
      status: "success", source: "official", scope: "account", count: 1, modelIds: ["fresh-official-model"],
    });
  });

  it("replaces old synchronized rows, keeps manual and unrelated rows, and records matching snapshot IDs", async () => {
    await seed();
    const manualBefore = (await repo.getCustomModels()).filter((model) => model.id.startsWith("manual"));
    stubDirectory({ data: [{ id: "fresh-official-model" }, { id: "manual-also-listed", name: "Upstream name" }] });
    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 2, added: 1, unchanged: 1, removed: 4 });
    const models = await repo.getCustomModels();
    expect(models.map((model) => model.id).sort()).toEqual([
      "fresh-official-model", "manual-also-listed", "manual-keep", "other-provider-model",
    ]);
    expect(models.filter((model) => model.id.startsWith("manual"))).toEqual(manualBefore);
    const snapshot = await snapshots.getModelSyncSnapshot("openai");
    expect(snapshot.modelIds).toEqual(["fresh-official-model", "manual-also-listed"]);
    expect(snapshot.count).toBe(2);
    expect(snapshot.syncedAt).not.toBe("2025-01-01T00:00:00.000Z");
    expect(await snapshots.getModelSyncSnapshots()).toEqual({ openai: snapshot });
    expect(JSON.stringify(snapshot)).not.toContain(connection.apiKey);
  });

  it("uses models.dev only to enrich listed IDs, never to add catalog-only IDs", async () => {
    stubDirectory({ data: [{ id: "fresh-official-model" }] }, 200, {
      openai: { models: {
        listed: { id: "fresh-official-model", name: "Catalog display name", tool_call: true, limit: { context: 100000 } },
        extra: { id: "catalog-only-model", name: "Must stay hidden", tool_call: true },
      } },
    });
    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, officialCount: 1, catalogCount: 1, staticCount: 0 });
    expect(await repo.getCustomModels()).toEqual([expect.objectContaining({
      id: "fresh-official-model", source: "official", capabilities: expect.objectContaining({ tools: true, contextWindow: 100000 }),
    })]);
    expect((await snapshots.getModelSyncSnapshot("openai")).modelIds).toEqual(["fresh-official-model"]);
  });

  it("retains official IDs when optional metadata is unavailable", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === MODELS_URL) return jsonResponse({ data: [{ id: "fresh-official-model" }] });
      throw new Error("Metadata unavailable; no live network allowed");
    });
    const response = await sync();
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect((await snapshots.getModelSyncSnapshot("openai")).modelIds).toEqual(["fresh-official-model"]);
  });

  it.each([
    ["missing connection ID", { connectionId: undefined }, 400],
    ["missing provider ID", { providerId: undefined }, 400],
    ["unknown connection", { connectionId: "missing" }, 404],
    ["mismatched provider", { providerId: "deepseek" }, 400],
  ])("rejects %s without fetching or modifying rows", async (_label, body, status) => {
    await seed();
    const before = rawState();
    const response = await sync({ officialFetched: true, supportedModels: [{ id: "forged" }], ...body });
    expect(response.status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rawState()).toEqual(before);
  });

  it("rejects an inactive connection without fetching or changing its snapshot", async () => {
    await seed();
    await connections.updateProviderConnection(connection.id, { isActive: false });
    const before = rawState();
    stubDirectory({ data: [{ id: "must-not-sync" }] });
    const response = await sync();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rawState()).toEqual(before);
  });

  it("rejects unsupported providers as 501 without promoting static or client-supplied models", async () => {
    const unsupported = await connections.createProviderConnection({ provider: "codebuddy-cn", authType: "apikey", apiKey: "fake-key" });
    const response = await sync({ providerId: "codebuddy-cn", connectionId: unsupported.id, supportedModels: [{ id: "forged" }] });
    expect(response.status).toBe(501);
    expect((await response.json()).discovery.status).toBe("unsupported");
    expect(rawState()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("protects previous rows and snapshot on a successful empty directory (409)", async () => {
    await seed();
    const before = rawState();
    stubDirectory({ data: [] });
    const response = await sync({ supportedModels: [{ id: "client-cannot-rescue-empty" }] });
    expect(response.status).toBe(409);
    expect((await response.json()).discovery).toMatchObject({ status: "success", source: "official", count: 0 });
    expect(rawState()).toEqual(before);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([MODELS_URL]);
  });

  it.each([
    ["HTTP failure", { error: "unavailable" }, 503],
    ["malformed payload", {}, 200],
    ["business failure", { data: [{ id: "untrusted" }], code: 401 }, 200],
    ["soft warning", { data: [{ id: "untrusted" }], warning: "incomplete" }, 200],
    ["partial page", { data: [{ id: "partial" }], has_more: true }, 200],
  ])("leaves exact rows and snapshot unchanged after %s", async (_label, payload, status) => {
    await seed();
    const before = rawState();
    stubDirectory(payload, status);
    const response = await sync({ officialFetched: true, supportedModels: [{ id: "forged" }] });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await response.json()).discovery.status).toBe("failed");
    expect(rawState()).toEqual(before);
  });

  it("does not create a success snapshot after a first failed sync", async () => {
    stubDirectory({ error: { message: "not authorized" } }, 401);
    expect((await sync()).status).toBe(401);
    expect(await snapshots.getModelSyncSnapshots()).toEqual({});
    expect(await repo.getCustomModels()).toEqual([]);
  });

  it("records public rather than account scope for a public catalog sync", async () => {
    const publicConnection = await connections.createProviderConnection({ provider: "opencode-go", authType: "apikey", apiKey: "do-not-send" });
    fetchMock.mockImplementation(async (url) => {
      if (url === "https://opencode.ai/inference/go/v1/models") return jsonResponse({ data: [{ id: "public-only-model" }] });
      if (url === METADATA_URL) return jsonResponse({});
      throw new Error("Unexpected external request");
    });
    expect((await sync({ providerId: "opencode-go", connectionId: publicConnection.id })).status).toBe(200);
    expect(await snapshots.getModelSyncSnapshot("opencode-go")).toMatchObject({
      providerAlias: "ocg", scope: "public", connectionId: publicConnection.id, modelIds: ["public-only-model"],
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("do-not-send");
  });
});

describe("atomic SQLite snapshot and row persistence", () => {
  it.each([
    ["snapshot write", "NEW.scope = 'modelSyncSnapshots'"],
    ["model row write after snapshot", "NEW.scope = 'customModels' AND NEW.key = 'openai|fresh-official-model|llm'"],
  ])("rolls back replacements and snapshot when the %s fails", async (_label, condition) => {
    await seed();
    const before = rawState();
    db.exec(`CREATE TEMP TRIGGER reject_test_sync BEFORE INSERT ON kv WHEN ${condition}
      BEGIN SELECT RAISE(ABORT, 'injected model sync persistence failure'); END;`);
    try {
      await expect(repo.syncCustomModels([
        { providerId: "openai", providerAlias: "openai", id: "fresh-official-model", source: "official" },
      ], {
        replaceSyncedFor: "openai",
        syncSnapshot: {
          providerId: "openai", providerAlias: "openai", connectionId: connection.id,
          scope: "account", models: [{ id: "fresh-official-model" }],
        },
      })).rejects.toThrow("injected model sync persistence failure");
      expect(rawState()).toEqual(before);
    } finally {
      db.exec("DROP TRIGGER reject_test_sync");
    }
  });
});

describe("snapshot-driven model visibility", () => {
  it("hides old synced and metadata-only unlisted IDs while retaining manual rows", async () => {
    await seed();
    await repo.upsertModelCapabilities({ providerAlias: "openai", providerId: "openai", id: "retired-built-in", capabilities: { vision: true } });
    stubDirectory({ data: [{ id: "fresh-official-model" }] });
    expect((await sync()).status).toBe(200);
    const modelSnapshots = await snapshots.getModelSyncSnapshots();
    const stored = await repo.getCustomModels();
    expect(stored.some((model) => model.id === "retired-built-in")).toBe(true);
    expect(visibility.shouldUseStaticModelCatalog("openai", modelSnapshots)).toBe(false);
    const visible = visibility.getProviderCustomModelRows({
      providerAlias: "openai", customModels: stored, snapshots: modelSnapshots,
    });
    expect(visible.map((model) => model.id).sort()).toEqual(["fresh-official-model", "manual-also-listed", "manual-keep"]);
    for (const source of ["static", "catalog", "models-dev", "official"]) {
      expect(visibility.isVisibleModelCatalogRow({ providerId: "openai", id: "not-in-snapshot", source }, modelSnapshots)).toBe(false);
    }
  });

  it("metadata-only rows cannot create models before or after a snapshot", () => {
    const model = { providerId: "openai", providerAlias: "openai", id: "retired-built-in", origin: "capability-override", capabilities: { tools: true } };
    expect(visibility.isVisibleModelCatalogRow(model, {})).toBe(false);
    const modelSnapshots = { openai: { status: "success", source: "official", modelIds: ["different-model"] } };
    expect(visibility.isVisibleModelCatalogRow(model, modelSnapshots)).toBe(false);
    expect(visibility.getProviderCustomModelRows({ providerAlias: "openai", customModels: [model], snapshots: modelSnapshots })).toEqual([]);
  });

  it("permits metadata for an ID actually listed by the official snapshot", () => {
    const modelSnapshots = { openai: { status: "success", source: "official", modelIds: ["listed-model"] } };
    expect(visibility.isVisibleModelCatalogRow({
      providerId: "openai", id: "listed-model", origin: "capability-override", capabilities: { vision: true },
    }, modelSnapshots)).toBe(true);
  });

  it("resolves canonical and storage aliases to the same official snapshot", () => {
    const snapshot = { providerId: "deepseek", providerAlias: "ds", status: "success", source: "official", modelIds: ["new-deepseek-model"] };
    const modelSnapshots = { deepseek: snapshot };
    expect(visibility.getOfficialModelSnapshot("ds", modelSnapshots)).toBe(snapshot);
    expect(visibility.hasOfficialModelSnapshot("deepseek", modelSnapshots)).toBe(true);
    expect(visibility.shouldUseStaticModelCatalog("ds", modelSnapshots)).toBe(false);
    expect(visibility.isVisibleModelCatalogRow({ providerAlias: "ds", id: "old-model", source: "official" }, modelSnapshots)).toBe(false);
  });

  it("does not treat failed or third-party snapshot markers as official evidence", () => {
    expect(visibility.getOfficialModelSnapshot("openai", { openai: { status: "failed", source: "official" } })).toBeNull();
    expect(visibility.getOfficialModelSnapshot("openai", { openai: { status: "success", source: "models-dev" } })).toBeNull();
  });
});
