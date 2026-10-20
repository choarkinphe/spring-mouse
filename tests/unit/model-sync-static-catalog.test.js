import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Static seeds and models.dev are metadata, never official discovery sources.
// Exercise real routes/repositories with isolated SQLite and stubbed upstreams.
let tempDir;
let fetchMock;
const originalDataDir = process.env.DATA_DIR;
const CATALOG_URL = "https://models.dev/api.json";
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-model-sync-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: { json: (body, init = {}) => jsonResponse(body, init.status || 200) },
  }));
  vi.doMock("@/lib/redis/hotCache.js", () => ({
    getHotJson: vi.fn(async () => null),
    setHotJson: vi.fn(async () => true),
    fillHotJson: vi.fn(async () => true),
    deleteHotJson: vi.fn(async () => true),
    incrementHotCounter: vi.fn(async () => 1),
  }));
  fetchMock = vi.fn().mockRejectedValue(new Error("Unexpected external request"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const post = (route, body) => route(new Request("http://localhost/api/providers/model-sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const createConnection = async (provider) => {
  const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
  return createProviderConnection({ provider, authType: "apikey", name: "Isolated test connection", apiKey: "test-key" });
};
const storedState = async () => {
  const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
  const { getModelSyncSnapshots } = await import("@/lib/db/repos/modelSyncRepo.js");
  return { models: await getCustomModels(), snapshots: await getModelSyncSnapshots() };
};

const seed = async (connection, providerAlias = connection.provider) => {
  const { addCustomModel, syncCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
  const { recordModelSyncSnapshot } = await import("@/lib/db/repos/modelSyncRepo.js");
  await addCustomModel({ providerAlias, id: "manual" });
  await syncCustomModels([
    { providerAlias, id: "old-official", source: "official" },
    { providerAlias, id: "old-catalog", source: "catalog" },
    { providerAlias, id: "old-static", source: "static" },
    { providerAlias: "openai", id: "other-provider", source: "official" },
  ]);
  await recordModelSyncSnapshot({
    providerId: connection.provider, providerAlias, connectionId: connection.id, scope: "account",
    models: [{ id: "old-official" }], syncedAt: "2026-01-01T00:00:00.000Z",
  });
  await recordModelSyncSnapshot({
    providerId: "openai", providerAlias: "openai", connectionId: "other-connection", scope: "account",
    models: [{ id: "other-provider" }], syncedAt: "2026-01-01T00:00:00.000Z",
  });
};

describe("provider model sync", () => {
  it("rejects a registry-only channel as unsupported without changing stored models or snapshots", async () => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const { getModelsByProviderId } = await import("open-sse/config/providerModels.js");
    const connection = await createConnection("codebuddy-cn");
    await seed(connection, "cbcn");
    const before = await storedState();
    const declared = getModelsByProviderId("codebuddy-cn");
    expect(declared.length).toBeGreaterThan(0);

    // A real static catalog and a claimed successful client fetch do not qualify.
    const res = await post(POST, {
      providerId: "codebuddy-cn", connectionId: connection.id, officialFetched: true, supportedModels: declared,
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/no implemented official model listing/i),
      discovery: { status: "unsupported", source: "official" },
    });
    expect(await storedState()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers live metadata over the static and external catalogs without unioning their IDs", async () => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const connection = await createConnection("deepseek");
    fetchMock.mockImplementation(async (url) => {
      if (url === "https://api.deepseek.com/models") return jsonResponse({
        data: [{ id: "deepseek-v4-pro", name: "Official DeepSeek V4 Pro" }],
      });
      if (url === CATALOG_URL) return jsonResponse({ deepseek: { models: {
        "deepseek-v4-pro": { id: "deepseek-v4-pro", name: "Catalog DeepSeek V4 Pro", tool_call: true },
        "catalog-only": { id: "catalog-only", name: "Not in upstream" },
      } } });
      throw new Error(`Unexpected external request: ${url}`);
    });
    const res = await post(POST, {
      providerId: "deepseek", connectionId: connection.id,
      officialFetched: true, supportedModels: [{ id: "client-only", name: "Forged" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, total: 1, officialCount: 1, catalogCount: 1, staticCount: 0,
      discovery: { status: "success", source: "official", scope: "account", count: 1 },
    });
    const state = await storedState();
    expect(state.models).toHaveLength(1);
    expect(state.models[0]).toMatchObject({
      providerAlias: "ds", id: "deepseek-v4-pro", source: "official",
      name: "Official DeepSeek V4 Pro", capabilities: { tools: true },
    });
    expect(state.snapshots.deepseek).toMatchObject({
      providerId: "deepseek", providerAlias: "ds", connectionId: connection.id,
      status: "success", source: "official", scope: "account", count: 1, modelIds: ["deepseek-v4-pro"],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://api.deepseek.com/models", CATALOG_URL]);
  });

  it.each(["qianwen", "qianwen-token-plan"])("replaces only synchronized rows with upstream ids for %s", async (providerId) => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const { QIANWEN_ENDPOINTS } = await import("open-sse/config/qianwen.js");
    const connection = await createConnection(providerId);
    const modelsUrl = QIANWEN_ENDPOINTS[providerId].models;
    fetchMock.mockImplementation(async (url) => {
      if (url === modelsUrl) return jsonResponse({ data: [{ id: "live" }, { id: "manual" }] });
      if (url === CATALOG_URL) return jsonResponse({
        [providerId === "qianwen" ? "alibaba-cn" : "alibaba-token-plan-cn"]: { models: {
          live: { id: "live", name: "Live catalog metadata", modalities: { input: ["text", "image"], output: ["text"] } },
          "catalog-only": { id: "catalog-only", name: "Not in upstream" },
        } },
      });
      throw new Error(`Unexpected external request: ${url}`);
    });
    await seed(connection);
    const before = await storedState();
    const res = await post(POST, { providerId, connectionId: connection.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, total: 2, officialCount: 2, catalogCount: 1, staticCount: 0, added: 1, unchanged: 1, removed: 3,
      discovery: { status: "success", source: "official", scope: "account", count: 2 },
    });
    const after = await storedState();
    const rows = after.models.filter(m => m.providerAlias === providerId);
    expect(rows.map(m => m.id).sort()).toEqual(["live", "manual"]);
    expect(rows.find(m => m.id === "live")).toMatchObject({
      name: "Live catalog metadata", source: "official", capabilities: { vision: true },
    });
    expect(rows.find(m => m.id === "manual")).toEqual(before.models.find(m => m.id === "manual"));
    expect(after.models.filter(m => m.providerAlias === "openai")).toEqual(before.models.filter(m => m.providerAlias === "openai"));
    expect(after.snapshots.openai).toEqual(before.snapshots.openai);
    expect(after.snapshots[providerId]).toMatchObject({
      providerId, providerAlias: providerId, connectionId: connection.id, status: "success", source: "official",
      scope: "account", count: 2, modelIds: ["live", "manual"], syncedAt: expect.any(String),
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([modelsUrl, CATALOG_URL]);

    // Empty official success is observable but cannot clear rows or replace the last snapshot.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const empty = await post(POST, { providerId, connectionId: connection.id, officialFetched: true, supportedModels: [] });
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({
      error: expect.stringMatching(/no models/i),
      discovery: { status: "success", source: "official", scope: "account", count: 0 },
    });
    expect(await storedState()).toEqual(after);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([modelsUrl, CATALOG_URL, modelsUrl]);
  });

  it("leaves stored Qianwen models and snapshots untouched on upstream HTTP or malformed-list failure", async () => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const { QIANWEN_ENDPOINTS } = await import("open-sse/config/qianwen.js");
    const connection = await createConnection("qianwen");
    await seed(connection);
    const before = await storedState();
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const response = await post(POST, { providerId: "qianwen", connectionId: connection.id, supportedModels: [] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "Failed to fetch models: 503", discovery: { status: "failed", source: "official" },
    });
    expect(await storedState()).toEqual(before);

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{}] }));
    const malformed = await post(POST, {
      providerId: "qianwen", connectionId: connection.id, officialFetched: true, supportedModels: [{ id: "client-only" }],
    });
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({
      error: "Upstream returned an invalid model list", discovery: { status: "failed", source: "official" },
    });
    expect(await storedState()).toEqual(before);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([QIANWEN_ENDPOINTS.qianwen.models, QIANWEN_ENDPOINTS.qianwen.models]);
  });

  it("rejects a channel with no official source and requires a connection before discovery", async () => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const connection = await createConnection("not-a-real-provider");
    await seed(connection);
    const before = await storedState();
    const missingConnection = await post(POST, { providerId: "not-a-real-provider", supportedModels: [] });
    expect(missingConnection.status).toBe(400);
    expect(await missingConnection.json()).toMatchObject({ error: "providerId and connectionId are required" });
    const res = await post(POST, { providerId: "not-a-real-provider", connectionId: connection.id });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/no implemented official model listing/i),
      discovery: { status: "unsupported", source: "official" },
    });
    expect(await storedState()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
