import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real route handlers and SQLite repositories in an isolated DATA_DIR.
// The official public directory is mocked; no provider credentials or live calls.
const MODELS_URL = "https://opencode.ai/inference/go/v1/models";
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let fetchMock;
let connection;
let GET;
let POST;
let repo;
let snapshots;

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" },
});
const getModels = (id = connection.id) => GET(new Request(`http://localhost/api/providers/${id}/models`), {
  params: Promise.resolve({ id }),
});
const sync = (body = {}) => POST(new Request("http://localhost/api/providers/model-sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ providerId: "opencode-go", connectionId: connection.id, ...body }),
}));

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-opencode-go-"));
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
  const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
  connection = await createProviderConnection({
    provider: "opencode-go", authType: "apikey", name: "Isolated test connection", apiKey: "test-key-not-for-discovery",
  });
  repo = await import("@/lib/db/repos/aliasRepo.js");
  snapshots = await import("@/lib/db/repos/modelSyncRepo.js");
  ({ GET } = await import("@/app/api/providers/[id]/models/route.js"));
  ({ POST } = await import("@/app/api/providers/model-sync/route.js"));
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

describe("OpenCode Go public model listing GET", () => {
  it("uses the official inference URL without credentials and maps only returned IDs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ object: "list", data: [
      { id: "minimax-m3", object: "model", created: 1, owned_by: "opencode" },
      { id: "new-go-model", object: "model", created: 2, owned_by: "opencode" },
    ] }));
    const response = await getModels();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      provider: "opencode-go", connectionId: connection.id, listingScope: "public",
      discovery: { status: "success", source: "official", scope: "public", count: 2, fetchedAt: expect.any(String) },
    });
    expect(body.models).toEqual([
      { id: "minimax-m3", name: "MiniMax M3", object: "model", created: 1, owned_by: "opencode", supportedFormats: ["openai", "claude"] },
      { id: "new-go-model", name: "new-go-model", object: "model", created: 2, owned_by: "opencode" },
    ]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(MODELS_URL, {
      method: "GET", headers: { Accept: "application/json" }, cache: "no-store", signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(body)).not.toContain(connection.apiKey);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(connection.apiKey);
  });

  it("does not require a token for the public directory", async () => {
    const { updateProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    await updateProviderConnection(connection.id, { apiKey: "" });
    fetchMock.mockResolvedValue(jsonResponse({ object: "list", data: [{ id: "public-model" }] }));
    const response = await getModels();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      discovery: { status: "success", source: "official", scope: "public", count: 1 },
    });
  });

  it("returns 404 for an unknown connection without fetching", async () => {
    const response = await getModels("missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "Connection not found", discovery: { status: "failed", source: "official" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 429, 503])("propagates upstream HTTP %s without a static fallback or upstream body", async (status) => {
    fetchMock.mockResolvedValue(new Response("sensitive upstream diagnostic", { status }));
    const response = await getModels();
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({
      error: `Failed to fetch models: ${status}`, discovery: { status: "failed", source: "official" },
    });
    expect(JSON.stringify(body)).not.toContain("sensitive upstream diagnostic");
  });

  it.each([
    null, {}, { models: [] }, { data: {} }, { data: [null] }, { data: [{}] },
    { data: [{ id: 7 }] }, { data: [{ id: "   " }] }, { data: [{ id: "valid" }, { name: "invalid" }] },
  ])("rejects malformed directory responses (%j)", async (payload) => {
    fetchMock.mockResolvedValue(jsonResponse(payload));
    const response = await getModels();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "Upstream returned an invalid model list", discovery: { status: "failed", source: "official" },
    });
  });

  it("rejects invalid JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>not JSON</html>"));
    const response = await getModels();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "Upstream returned an invalid model list", discovery: { status: "failed", source: "official" },
    });
  });

  it.each([new Error("network unavailable"), new DOMException("timed out", "TimeoutError")])("fails closed on fetch errors (%s)", async (error) => {
    fetchMock.mockRejectedValue(error);
    const response = await getModels();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Failed to fetch models", discovery: { status: "failed", source: "official" },
    });
  });

  it("accepts a successful empty directory without restoring the static seed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ object: "list", data: [] }));
    const response = await getModels();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      models: [], discovery: { status: "success", source: "official", scope: "public", count: 0 },
    });
  });
});

describe("OpenCode Go model sync with real isolated persistence", () => {
  const storedState = async () => ({
    models: await repo.getCustomModels(),
    snapshots: await snapshots.getModelSyncSnapshots(),
  });
  const seed = async () => {
    await repo.addCustomModel({ providerAlias: "ocg", id: "manual-keep", name: "My manual model" });
    await repo.addCustomModel({ providerAlias: "ocg", id: "manual-also-listed" });
    await repo.syncCustomModels([
      { providerAlias: "ocg", providerId: "opencode-go", id: "old-official", source: "official" },
      { providerAlias: "ocg", id: "old-static", source: "static" },
      { providerAlias: "ocg", id: "old-catalog", source: "catalog" },
      { providerAlias: "ocg", id: "old-models-dev", source: "models-dev" },
      { providerAlias: "ds", id: "other-provider", source: "official" },
    ]);
    await snapshots.recordModelSyncSnapshot({
      providerId: "opencode-go", providerAlias: "ocg", connectionId: connection.id,
      scope: "public", models: [{ id: "old-official" }], syncedAt: "2026-01-01T00:00:00.000Z",
    });
    await snapshots.recordModelSyncSnapshot({
      providerId: "deepseek", providerAlias: "ds", connectionId: "other-connection",
      scope: "account", models: [{ id: "other-provider" }], syncedAt: "2026-01-01T00:00:00.000Z",
    });
  };

  it("replaces stale synchronized rows with the public list, never unions static IDs, and preserves manual rows", async () => {
    await seed();
    const beforeManual = (await repo.getCustomModels()).filter(m => m.id.startsWith("manual"));
    const otherSnapshot = await snapshots.getModelSyncSnapshot("deepseek");
    fetchMock.mockImplementation(async () => jsonResponse({ object: "list", data: [
      { id: "minimax-m3" }, { id: "new-go-model" }, { id: "manual-also-listed" },
    ] }));
    const listing = await (await getModels()).json();
    expect(listing.discovery).toMatchObject({ status: "success", source: "official", count: 3 });
    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true, total: 3, officialCount: 3, catalogCount: 0, staticCount: 0, added: 2, unchanged: 1, removed: 4,
      discovery: { status: "success", source: "official", scope: "public", count: 3 },
    });
    const rows = await repo.getCustomModels();
    const go = rows.filter(m => m.providerAlias === "ocg");
    expect(go.map(m => m.id).sort()).toEqual(["manual-also-listed", "manual-keep", "minimax-m3", "new-go-model"]);
    expect(go.filter(m => m.id.startsWith("manual"))).toEqual(beforeManual);
    expect(go.find(m => m.id === "minimax-m3")).toMatchObject({ providerId: "opencode-go", source: "official", supportedFormats: ["openai", "claude"] });
    expect(go.find(m => m.id === "new-go-model").supportedFormats).toBeUndefined();
    expect(rows.some(m => m.id === "other-provider")).toBe(true);
    expect(await snapshots.getModelSyncSnapshot("opencode-go")).toMatchObject({
      providerId: "opencode-go", providerAlias: "ocg", connectionId: connection.id,
      status: "success", source: "official", scope: "public", count: 3,
      modelIds: ["minimax-m3", "new-go-model", "manual-also-listed"], syncedAt: expect.any(String),
    });
    expect(await snapshots.getModelSyncSnapshot("deepseek")).toEqual(otherSnapshot);
    // GET previews the directory; POST independently discovers it again. No models.dev union.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([MODELS_URL, MODELS_URL]);
  });

  it("retains known protocol annotations even when syncing a raw official list", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "glm-5.1" }, { id: "new-go-model" }] }));
    const response = await sync({
      officialFetched: false,
      supportedModels: [{ id: "glm-5.1", supportedFormats: ["forged-format"] }, { id: "client-only" }],
    });
    expect(response.status).toBe(200);
    const rows = await repo.getCustomModels();
    expect(rows.find(m => m.id === "glm-5.1").supportedFormats).toEqual(["openai"]);
    expect(rows.find(m => m.id === "new-go-model").supportedFormats).toBeUndefined();
    expect(rows.map(m => m.id).sort()).toEqual(["glm-5.1", "new-go-model"]);
    expect(await snapshots.getModelSyncSnapshot("opencode-go")).toMatchObject({
      count: 2, modelIds: ["glm-5.1", "new-go-model"], connectionId: connection.id,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a successful empty official list without changing rows or snapshots", async () => {
    await seed();
    const before = await storedState();
    fetchMock.mockImplementation(async () => jsonResponse({ object: "list", data: [] }));
    const listing = await (await getModels()).json();
    expect(listing.discovery).toMatchObject({ status: "success", source: "official", count: 0 });
    const response = await sync({ officialFetched: true, supportedModels: [{ id: "client-only" }] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/no models/i),
      discovery: { status: "success", source: "official", scope: "public", count: 0 },
    });
    expect(await storedState()).toEqual(before);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {}, { officialFetched: false, supportedModels: [] }, { officialFetched: true },
    { officialFetched: true, supportedModels: {} }, { officialFetched: true, supportedModels: [{}] },
    { officialFetched: true, supportedModels: [{ id: " " }] }, { officialFetched: true, supportedModels: [{ id: 3 }] },
  ])("does not trust client fields or mutate persistence on invalid official discovery (%j)", async (payload) => {
    await seed();
    const before = await storedState();
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "valid" }, {}] }));
    const response = await sync(payload);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "Upstream returned an invalid model list", discovery: { status: "failed", source: "official" },
    });
    expect(await storedState()).toEqual(before);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires a connection ID even when the client claims successful discovery", async () => {
    await seed();
    const before = await storedState();
    const response = await sync({ connectionId: undefined, officialFetched: true, supportedModels: [{ id: "client-only" }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "providerId and connectionId are required" });
    expect(await storedState()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps stored rows and snapshots unchanged after a failed GET and fallback-empty sync", async () => {
    await seed();
    const before = await storedState();
    fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    const listingResponse = await getModels();
    const listing = await listingResponse.json();
    expect(listingResponse.status).toBe(503);
    expect(listing).toMatchObject({ discovery: { status: "failed", source: "official" } });
    const response = await sync({ officialFetched: listingResponse.ok, supportedModels: listing.models || [] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "Failed to fetch models: 503", discovery: { status: "failed", source: "official" },
    });
    expect(await storedState()).toEqual(before);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the dashboard and internal API catalogs limited to listed/manual rows, not the static seed", async () => {
    await seed();
    const { GET: dashboardModels } = await import("@/app/api/models/route.js");
    const response = await dashboardModels(new Request("http://localhost/api/models"));
    expect(response.status).toBe(200);
    const data = await response.json();
    const ids = data.models.filter(m => ["opencode-go", "ocg"].includes(m.provider)).map(m => m.model).sort();
    expect(ids).toEqual(["manual-also-listed", "manual-keep", "old-official"]);
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"], { skipDynamicFetch: true, includeProviderModels: true });
    expect(models.filter(m => ["opencode-go", "ocg"].includes(m.owned_by)).map(m => m.id).sort())
      .toEqual(["ocg/manual-also-listed", "ocg/manual-keep", "ocg/old-official"]);
  });

  it("hides legacy static/catalog rows by both canonical provider ID and ocg storage alias", async () => {
    const { getProviderCustomModelRows, isListedCustomModel } = await import("@/shared/utils/providerCustomModels.js");
    const { supportsLiveModelSync, usesUpstreamModelList } = await import("@/shared/constants/providers.js");
    expect(supportsLiveModelSync("opencode-go")).toBe(true);
    expect(usesUpstreamModelList("opencode-go")).toBe(true);
    await seed();
    const rows = getProviderCustomModelRows({ customModels: await repo.getCustomModels(), providerAlias: "ocg" });
    expect(rows.map(m => m.id).sort()).toEqual(["manual-also-listed", "manual-keep", "old-official"]);
    expect(isListedCustomModel({ providerId: "opencode-go", source: "static" })).toBe(false);
    expect(isListedCustomModel({ providerAlias: "ocg", source: "static" })).toBe(false);
  });
});
