import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real sync/model routes and SQLite repositories run in an isolated DATA_DIR.
// All external provider/model-catalog requests are intercepted by fetch mocks.
const originalDataDir = process.env.DATA_DIR;
const MODELS_DEV_URL = "https://models.dev/api.json";
let tempDir;
let fetchMock;
let connection;
let POST_SYNC;
let customModelsGET;
let dashboardModelsGET;
let repos;
let snapshots;

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" },
});
const sync = (providerId = connection.provider, connectionId = connection.id) => POST_SYNC(new Request(
  "http://localhost/api/providers/model-sync",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, connectionId }),
  },
));

async function createConnection(provider, extra = {}) {
  const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
  return createProviderConnection({
    provider,
    authType: "apikey",
    name: `Isolated ${provider} model test`,
    apiKey: "test-only-directory-key",
    ...extra,
  });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-model-review-"));
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
  fetchMock = vi.fn().mockRejectedValue(new Error("Unexpected external request in regression test"));
  vi.stubGlobal("fetch", fetchMock);
  // Mock the transport, never resolveKimchiModels: its raw validator must run.
  vi.doMock("open-sse/utils/proxyFetch.js", () => ({
    default: (...args) => fetchMock(...args),
    proxyAwareFetch: (...args) => fetchMock(...args),
  }));
  vi.doMock("@/shared/config/officialModelCatalog", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, OFFICIAL_MODEL_CATALOG: {
      ...actual.OFFICIAL_MODEL_CATALOG,
      "review-declarative-provider": {
        url: "https://official-review.invalid/v1/models", auth: "bearer", scope: "account",
      },
    } };
  });

  repos = await import("@/lib/db/repos/aliasRepo.js");
  snapshots = await import("@/lib/db/repos/modelSyncRepo.js");
  ({ POST: POST_SYNC } = await import("@/app/api/providers/model-sync/route.js"));
  ({ GET: customModelsGET } = await import("@/app/api/models/custom/route.js"));
  ({ GET: dashboardModelsGET } = await import("@/app/api/models/route.js"));
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

describe("official model sync review regressions", () => {
  it("normalizes Anthropic model objects to LLM rows and snapshots only official IDs", async () => {
    connection = await createConnection("anthropic");
    fetchMock.mockImplementation(async (url) => {
      if (url === "https://api.anthropic.com/v1/models") {
        return jsonResponse({
          data: [
            { id: "claude-sonnet-test", type: "model", display_name: "Claude Sonnet Test", created_at: "2026-10-01T00:00:00Z" },
            { id: "claude-haiku-test", type: "model", display_name: "Claude Haiku Test" },
          ],
          has_more: false,
        });
      }
      if (url === MODELS_DEV_URL) {
        return jsonResponse({ anthropic: { models: {
          "claude-sonnet-test": {
            id: "claude-sonnet-test",
            name: "Catalog name must not replace the official display name",
            tool_call: true,
          },
          "catalog-only-model": { id: "catalog-only-model", name: "Not returned by Anthropic" },
        } } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, total: 2, officialCount: 2, catalogCount: 1 });
    const stored = await repos.getCustomModels();
    expect(stored).toHaveLength(2);
    expect(stored.map(({ id }) => id).sort()).toEqual(["claude-haiku-test", "claude-sonnet-test"]);
    expect(stored.find((model) => model.id === "claude-sonnet-test").capabilities).toMatchObject({ tools: true });
    expect((await snapshots.getModelSyncSnapshot("anthropic")).modelIds.slice().sort())
      .toEqual(stored.map((model) => model.id).sort());
    expect(stored).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "anthropic", providerAlias: "anthropic", id: "claude-sonnet-test",
        type: "llm", kind: "llm", source: "official", name: "Claude Sonnet Test",
      }),
      expect.objectContaining({
        providerId: "anthropic", id: "claude-haiku-test", type: "llm", kind: "llm", source: "official",
      }),
    ]));
    expect(await snapshots.getModelSyncSnapshot("anthropic")).toMatchObject({
      providerId: "anthropic",
      providerAlias: "anthropic",
      connectionId: connection.id,
      scope: "account",
      source: "official",
      status: "success",
      count: 2,
      modelIds: ["claude-sonnet-test", "claude-haiku-test"],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.anthropic.com/v1/models",
      MODELS_DEV_URL,
    ]);
  });

  it("normalizes Codex upstream type=model to internal LLM and matching snapshot IDs", async () => {
    connection = await createConnection("codex", { authType: "oauth", accessToken: "test-only-codex-token" });
    fetchMock.mockImplementation(async (url, options) => {
      if (url === "https://chatgpt.com/backend-api/codex/models?client_version=0.144.6") {
        expect(options.headers.Authorization).toBe("Bearer test-only-codex-token");
        return jsonResponse({ data: [{ id: "codex-new-review-model", type: "model", name: "New Codex model" }] });
      }
      if (url === MODELS_DEV_URL) return jsonResponse({});
      throw new Error(`Unexpected URL: ${url}`);
    });

    const response = await sync();

    expect(response.status).toBe(200);
    const stored = await repos.getCustomModels();
    expect(stored).toEqual([expect.objectContaining({
      providerId: "codex", providerAlias: "cx", id: "codex-new-review-model",
      type: "llm", kind: "llm", source: "official",
    })]);
    expect(await snapshots.getModelSyncSnapshot("codex")).toMatchObject({
      status: "success", source: "official", modelIds: ["codex-new-review-model"], count: 1,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://chatgpt.com/backend-api/codex/models?client_version=0.144.6",
      MODELS_DEV_URL,
    ]);
  });

  it("uses ElevenLabs model_id values as TTS IDs and exposes newly discovered models", async () => {
    connection = await createConnection("elevenlabs");
    fetchMock.mockResolvedValue(jsonResponse([
      { model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true },
      { model_id: "eleven_new_review_model", name: "New Review Voice Model", can_do_text_to_speech: true },
    ]));

    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, total: 2, officialCount: 2 });
    const stored = await repos.getCustomModels();
    expect(stored.map(({ id, type }) => ({ id, type })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "eleven_multilingual_v2", type: "tts" },
      { id: "eleven_new_review_model", type: "tts" },
    ]);

    const customResponse = await customModelsGET(new Request("http://localhost/api/models/custom"));
    expect(customResponse.status).toBe(200);
    const customBody = await customResponse.json();
    expect(customBody.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "eleven_new_review_model", name: "New Review Voice Model", type: "tts", source: "official" }),
    ]));
    expect(customBody.snapshots.elevenlabs).toMatchObject({
      source: "official", scope: "account", modelIds: ["eleven_multilingual_v2", "eleven_new_review_model"],
    });

    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    const ttsModels = await buildModelsList(["tts"], { includeProviderModels: true, skipDynamicFetch: true });
    expect(ttsModels.filter((model) => model.owned_by === "el").map((model) => model.id).sort()).toEqual([
      "el/eleven_multilingual_v2",
      "el/eleven_new_review_model",
    ]);
    expect(ttsModels.some((model) => model.id === "el/eleven_new_review_model" && model.kind === "llm")).toBe(false);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://api.elevenlabs.io/v1/models", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ "xi-api-key": "test-only-directory-key" }),
    }));
  });

  it("discovers and routes a newly declared official-catalog provider model", async () => {
    const providerId = "review-declarative-provider";
    connection = await createConnection(providerId);
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "new-official-catalog-model", name: "New Official Model" }] }));

    const response = await sync(providerId, connection.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, total: 1, officialCount: 1 });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://official-review.invalid/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-only-directory-key" }),
      }),
    );
    expect(await repos.getCustomModels()).toEqual([
      expect.objectContaining({
        providerId, providerAlias: providerId, id: "new-official-catalog-model",
        type: "llm", kind: "llm", source: "official", name: "New Official Model",
      }),
    ]);
    expect(await snapshots.getModelSyncSnapshot(providerId)).toMatchObject({
      providerId, providerAlias: providerId, connectionId: connection.id,
      source: "official", status: "success", modelIds: ["new-official-catalog-model"],
    });

    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"], { includeProviderModels: true, skipDynamicFetch: true });
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${providerId}/new-official-catalog-model`, owned_by: providerId }),
    ]));
  });

  it("stores and lists Deepgram canonical identifiers as STT models", async () => {
    connection = await createConnection("deepgram");
    fetchMock.mockResolvedValue(jsonResponse({
      stt: [{ name: "Nova 4", canonical_name: "nova-4", uuid: "stt-internal-uuid" }],
      tts: [{ name: "Zeus", canonical_name: "aura-2-zeus-en", uuid: "tts-internal-uuid" }],
    }));

    const response = await sync();
    expect(response.status).toBe(200);
    const stored = await repos.getCustomModels();
    expect(stored.map(({ id, name, type, kind }) => ({ id, name, type, kind })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "aura-2-zeus-en", name: "Zeus", type: "tts", kind: "tts" },
      { id: "nova-4", name: "Nova 4", type: "stt", kind: "stt" },
    ]);
    expect(stored.some(({ id }) => id.includes("uuid"))).toBe(false);

    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    const sttModels = await buildModelsList(["stt"], { includeProviderModels: true, skipDynamicFetch: true });
    expect(sttModels.filter((model) => model.owned_by === "dg").map((model) => model.id)).toEqual(["dg/nova-4"]);

    // Exercise the actual inline registered-row projection without needing a
    // browser renderer or copying the projection into the regression test.
    const pickerSource = fs.readFileSync(fileURLToPath(new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url)), "utf8");
    const branch = pickerSource.slice(pickerSource.indexOf("// Custom models registered via /api/models/custom"));
    const projection = branch.match(/\.map\(\(m\) => \(\{[^\n]+\}\)\)/)?.[0];
    expect(projection).toBeTruthy();
    const { getModelKind } = await import("@/shared/constants/models.js");
    const projectRows = new Function("rows", "alias", "getModelKind", "snapshots", "providerId", `return rows${projection};`);
    const projected = projectRows(stored, "dg", getModelKind, await snapshots.getModelSyncSnapshots(), "deepgram");
    expect(projected.filter((model) => getModelKind(model) === "stt").map((model) => model.id)).toEqual(["nova-4"]);
    expect(projected.filter((model) => getModelKind(model) === "tts").map((model) => model.id)).toEqual(["aura-2-zeus-en"]);
  });

  it("keeps a hand-added overlapping model manual and does not label its picker row official", async () => {
    connection = await createConnection("anthropic");
    await repos.addCustomModel({ providerAlias: "anthropic", id: "claude-sonnet-test", name: "My pinned Sonnet" });
    // Add user-owned capability metadata to the real stored manual row.
    const db = await (await import("@/lib/db/driver.js")).getAdapter();
    const row = db.get("SELECT value FROM kv WHERE scope = 'customModels' AND key = ?", ["anthropic|claude-sonnet-test|llm"]);
    db.run("UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?", [
      JSON.stringify({ ...JSON.parse(row.value), capabilities: { vision: true, contextWindow: 12345 } }),
      "anthropic|claude-sonnet-test|llm",
    ]);
    db.flush?.();
    fetchMock.mockImplementation(async (url) => {
      if (url === "https://api.anthropic.com/v1/models") return jsonResponse({
        data: [{ id: "claude-sonnet-test", type: "model", display_name: "Official upstream label" }],
      });
      if (url === MODELS_DEV_URL) return jsonResponse({ anthropic: { models: {} } });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const response = await sync();
    expect(response.status).toBe(200);
    const manual = (await repos.getCustomModels()).find((model) => model.id === "claude-sonnet-test");
    expect(manual).toMatchObject({
      providerAlias: "anthropic", id: "claude-sonnet-test",
      type: "llm", name: "My pinned Sonnet", capabilities: { vision: true, contextWindow: 12345 },
    });
    expect(manual).not.toHaveProperty("providerId");
    expect(manual).not.toHaveProperty("source");

    const { getProviderCustomModelRows } = await import("@/shared/utils/providerCustomModels.js");
    const pickerRows = getProviderCustomModelRows({
      customModels: await repos.getCustomModels(),
      providerAlias: "anthropic",
      providerAliases: [],
      snapshots: await snapshots.getModelSyncSnapshots(),
      type: "llm",
    });
    expect(pickerRows).toEqual([
      expect.objectContaining({
        id: "claude-sonnet-test", name: "My pinned Sonnet", type: "llm", source: "custom",
        capabilities: { vision: true, contextWindow: 12345 },
      }),
    ]);
    expect(pickerRows[0]).not.toHaveProperty("modelSource");
  });

  it("does not return disabled registry or non-registry custom models from the dashboard API", async () => {
    const { AI_MODELS } = await import("@/shared/constants/config.js");
    const { getProviderAlias } = await import("@/shared/constants/providers.js");
    const { disableModels } = await import("@/lib/db/repos/disabledModelsRepo.js");
    const registeredProvider = "deepseek";
    const registeredId = "deepseek-chat";
    const customId = "deepseek-review-disabled-custom";
    expect(AI_MODELS.some((model) => [registeredProvider, "ds"].includes(model.provider) && model.model === registeredId)).toBe(true);
    expect(AI_MODELS.some((model) => model.model === customId)).toBe(false);
    connection = await createConnection(registeredProvider);
    fetchMock.mockImplementation(async (url) => {
      if (url === "https://api.deepseek.com/models") {
        return jsonResponse({ data: [{ id: registeredId }, { id: customId }] });
      }
      if (url === MODELS_DEV_URL) return jsonResponse({});
      throw new Error(`Unexpected URL: ${url}`);
    });
    const syncResponse = await sync();
    expect(syncResponse.status).toBe(200);
    const registeredAlias = getProviderAlias(registeredProvider) || registeredProvider;
    await disableModels(registeredAlias, [registeredId, customId]);

    const response = await dashboardModelsGET(new Request("http://localhost/api/models"));
    expect(response.status).toBe(200);
    const models = (await response.json()).models;
    expect(models.some((model) => model.provider === registeredProvider && model.model === registeredId)).toBe(false);
    expect(models.some((model) => model.provider === registeredProvider && model.model === customId)).toBe(false);
  });
});

describe("Kimchi official directory raw-response validation", () => {
  beforeEach(() => {
    vi.doMock("open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: (...args) => fetchMock(...args),
    }));
  });

  it.each([
    ["raw warning", { models: [{ slug: "valid-model" }], warning: "upstream is partial" }],
    ["business failure", { models: [{ slug: "valid-model" }], success: false }],
    ["has_more", { models: [{ slug: "valid-model" }], has_more: true }],
    ["next page token", { models: [{ slug: "valid-model" }], next_page_token: "page-2" }],
    ["partially invalid entries", { models: [{ slug: "valid-model" }, { name: "missing-id" }] }],
  ])("rejects Kimchi %s before normalizing or caching its model list", async (_label, payload) => {
    const { resolveKimchiModels, clearKimchiCatalog } = await import("open-sse/services/kimchiModels.js");
    clearKimchiCatalog();
    fetchMock.mockImplementation(async () => jsonResponse(payload));
    const result = await resolveKimchiModels({ apiKey: "test-only-kimchi-key" }, { forceRefresh: true });
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://llm.kimchi.dev/v1/models/metadata?include_in_cli=true",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-only-kimchi-key" }),
        cache: "no-store",
      }),
      null,
    );

    connection = await createConnection("kimchi");
    await repos.syncCustomModels([
      { providerId: "kimchi", providerAlias: "kimchi", id: "previous-official-model", type: "llm", source: "official" },
    ], {
      replaceSyncedFor: "kimchi",
      syncSnapshot: {
        providerId: "kimchi", providerAlias: "kimchi", connectionId: connection.id,
        scope: "account", models: ["previous-official-model"],
      },
    });
    const previousRows = await repos.getCustomModels();
    const previousSnapshot = await snapshots.getModelSyncSnapshot("kimchi");
    fetchMock.mockClear();

    const response = await sync();

    expect(response.status).toBe(502);
    expect((await response.json()).discovery).toMatchObject({ status: "failed", source: "official" });
    expect(await repos.getCustomModels()).toEqual(previousRows);
    expect(await snapshots.getModelSyncSnapshot("kimchi")).toEqual(previousSnapshot);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
