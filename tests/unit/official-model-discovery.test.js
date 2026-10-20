import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real routes and SQLite; only external I/O is replaced. Never inspect a user's
// connections or send a request to a live provider during these contract tests.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let connections;
let GET;
let fetchMock;
let contract;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const createConnection = (provider, extra = {}) => connections.createProviderConnection({
  provider, authType: "apikey", name: "Isolated discovery test", apiKey: "test-only-api-key", ...extra,
});
const getModels = (id) => GET(new Request(`http://localhost/api/providers/${id}/models`), {
  params: Promise.resolve({ id }),
});

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-official-discovery-"));
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
  connections = await import("@/lib/db/repos/connectionsRepo.js");
  ({ GET } = await import("@/app/api/providers/[id]/models/route.js"));
  contract = await import("@/shared/utils/officialModelDiscovery.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
});

beforeEach(() => {
  db.run("DELETE FROM providerConnections");
  db.run("DELETE FROM kv");
  fetchMock.mockReset().mockRejectedValue(new Error("Unexpected external request in discovery test"));
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

describe("official model directory GET contract", () => {
  it.each([
    ["opencode-go", "https://opencode.ai/inference/go/v1/models"],
    ["venice", "https://api.venice.ai/api/v1/models"],
  ])("reads the public %s directory without transmitting stored credentials", async (provider, url) => {
    const connection = await createConnection(provider, {
      accessToken: "test-only-access-token", refreshToken: "test-only-refresh-token",
    });
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "brand-new-model" }] }));
    const response = await getModels(connection.id);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      provider, connectionId: connection.id, models: [{ id: "brand-new-model" }],
      discovery: { status: "success", source: "official", scope: "public", count: 1 },
    });
    expect(Number.isNaN(Date.parse(body.discovery.fetchedAt))).toBe(false);
    expect(contract.isSuccessfulOfficialDiscovery(body)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(new Headers(options.headers).has("Authorization")).toBe(false);
    expect(new Headers(options.headers).has("x-api-key")).toBe(false);
    for (const secret of [connection.apiKey, connection.accessToken, connection.refreshToken]) {
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  });

  it("allows public discovery even when the connection has no credentials", async () => {
    const connection = await createConnection("venice", { apiKey: "" });
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "public-model" }] }));
    expect((await getModels(connection.id)).status).toBe(200);
  });

  it("authenticates an account directory and returns only upstream IDs", async () => {
    const connection = await createConnection("openai");
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "account-only-new-model" }, { id: "account-only-new-model" }] }));
    const response = await getModels(connection.id);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.models.map((model) => model.id)).toEqual(["account-only-new-model"]);
    expect(body.discovery).toMatchObject({ status: "success", source: "official", scope: "account", count: 1 });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${connection.apiKey}`);
    expect(JSON.stringify(body)).not.toContain(connection.apiKey);
  });

  it("refuses account discovery without a token before making a request", async () => {
    const connection = await createConnection("openai", { apiKey: "" });
    const response = await getModels(connection.id);
    expect(response.status).toBe(401);
    expect((await response.json()).discovery.status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown connection without fetching", async () => {
    expect((await getModels("not-a-connection")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unsupported discovery as 501 instead of returning a static registry", async () => {
    const connection = await createConnection("codebuddy-cn");
    const response = await getModels(connection.id);
    const body = await response.json();
    expect(response.status).toBe(501);
    expect(body.discovery).toMatchObject({ status: "unsupported", source: "official" });
    expect(body.models).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])("does not fall back on upstream HTTP %i", async (status) => {
    const connection = await createConnection("openai");
    fetchMock.mockResolvedValue(new Response("sensitive upstream body", { status }));
    const response = await getModels(connection.id);
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body.discovery.status).toBe("failed");
    expect(body.models).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sensitive upstream body");
  });

  it.each([
    ["missing list", {}], ["null payload", null], ["object list", { data: {} }],
    ["null entry", { data: [null] }], ["numeric ID", { data: [{ id: 9 }] }],
    ["blank ID", { data: [{ id: " " }] }], ["padded ID", { data: [{ id: " padded " }] }],
    ["partially malformed list", { data: [{ id: "valid" }, { name: "not-an-id" }] }],
    ["business error", { data: [{ id: "valid" }], error: { message: "not entitled" } }],
    ["unsuccessful business status", { data: [{ id: "valid" }], success: false }],
    ["business error code", { data: [{ id: "valid" }], code: 401 }],
    ["soft warning", { data: [{ id: "valid" }], warning: "served stale directory" }],
    ["has_more pagination", { data: [{ id: "page-one" }], has_more: true }],
    ["next_page_token pagination", { data: [{ id: "page-one" }], next_page_token: "next" }],
    ["nextPageToken pagination", { data: [{ id: "page-one" }], nextPageToken: "next" }],
  ])("rejects %s rather than stamping official success", async (_label, payload) => {
    const connection = await createConnection("openai");
    fetchMock.mockResolvedValue(jsonResponse(payload));
    const response = await getModels(connection.id);
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.discovery.status).toBe("failed");
    expect(body.models).toBeUndefined();
    expect(contract.isSuccessfulOfficialDiscovery(body)).toBe(false);
  });

  it.each([
    ["business failure", { success: false }], ["business error code", { code: 401 }],
    ["soft warning", { warning: "stale directory" }], ["partial listing", { has_more: true }],
    ["next page", { next_page_token: "next" }],
  ])("applies failure checks to the public custom resolver: %s", async (_label, extra) => {
    const connection = await createConnection("opencode-go");
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "must-not-be-admitted" }], ...extra }));
    const response = await getModels(connection.id);
    expect(response.status).toBe(502);
    expect((await response.json()).discovery.status).toBe("failed");
  });

  it.each([
    ["soft warning", { warning: "stale models" }],
    ["pagination", { has_more: true }],
    ["business code", { code: 401 }],
  ])("does not stamp an OAuth custom resolver response successful after %s", async (_label, extra) => {
    const connection = await createConnection("codex", { authType: "oauth", accessToken: "test-only-oauth-token" });
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ id: "oauth-model" }], ...extra }));
    const response = await getModels(connection.id);
    expect(response.status).toBe(502);
    expect((await response.json()).discovery.status).toBe("failed");
  });

  it("rejects invalid JSON without a registry fallback", async () => {
    const connection = await createConnection("openai");
    fetchMock.mockResolvedValue(new Response("<html>not a directory</html>"));
    const response = await getModels(connection.id);
    expect(response.status).toBe(502);
    expect((await response.json()).models).toBeUndefined();
  });

  it("reports network failure without returning static IDs or exception secrets", async () => {
    const connection = await createConnection("openai");
    fetchMock.mockRejectedValue(new Error("private network credential diagnostic"));
    const response = await getModels(connection.id);
    const body = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(body.discovery.status).toBe("failed");
    expect(body.models).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private network credential diagnostic");
  });

  it("makes an empty official response observable without resurrecting built-in models", async () => {
    const connection = await createConnection("openai");
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const response = await getModels(connection.id);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.discovery).toMatchObject({ status: "success", source: "official", scope: "account", count: 0 });
  });
});
