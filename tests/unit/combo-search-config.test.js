import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getComboSearchProviders, normalizeComboSearch, getComboSearchValidationError } from "../../open-sse/services/comboSearch.js";

const binding = { mode: "gateway", provider: "brave-search", maxResults: 5 };
const leaf = "openai/gpt-4o";
const dataDir = await mkdtemp(path.join(tmpdir(), "spring-mouse-combo-search-"));
process.env.DATA_DIR = dataDir;
let POST, PUT, GET, getComboById, getAdapter;
beforeAll(async () => {
  ({ POST } = await import("@/app/api/combos/route.js"));
  ({ PUT, GET } = await import("@/app/api/combos/[id]/route.js"));
  ({ getComboById } = await import("@/lib/db/repos/combosRepo.js"));
  ({ getAdapter } = await import("@/lib/db/driver.js"));
});
afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });
const request = (body) => new Request("http://localhost/api/combos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const create = (name, extra = {}) => POST(request({ name, models: [leaf], ...extra }));
const update = (id, patch) => PUT(request(patch), { params: Promise.resolve({ id }) });

describe("combo search contract", () => {
  it("derives canonical dedicated choices from registry, never chat-backed search", () => {
    const ids = getComboSearchProviders().map(({ id }) => id);
    expect(ids).toContain("brave-search");
    for (const provider of REGISTRY) {
      expect(ids.includes(provider.id)).toBe(!!(provider.searchConfig || provider.media?.searchConfig));
    }
    expect(ids).not.toContain("brave");
  });
  it("defaults disabled and normalizes the fixed result limit", () => {
    expect(normalizeComboSearch(null)).toBeNull();
    expect(normalizeComboSearch(undefined)).toBeNull();
    expect(normalizeComboSearch({ mode: "gateway", provider: "brave-search" })).toEqual(binding);
    expect(normalizeComboSearch(binding)).toEqual(binding);
  });
  it.each([false, [], "brave-search", {}, { ...binding, mode: "native" }, { ...binding, provider: "brave" }, { ...binding, provider: "unknown" }, { ...binding, maxResults: 10 }, { ...binding, maxResults: "5" }, { ...binding, apiKey: "secret" }, { ...binding, url: "https://example.com" }])("rejects invalid or credential-bearing config %j", (value) => {
    expect(normalizeComboSearch(value)).toBeUndefined();
    expect(getComboSearchValidationError(value)).toBeTruthy();
  });
  it("requires an LLM combo with a reachable tools leaf", () => {
    expect(getComboSearchValidationError(binding, { models: [leaf], combos: [] })).toBeNull();
    expect(getComboSearchValidationError(binding, { kind: "webSearch", models: [leaf] })).toContain("LLM");
    expect(getComboSearchValidationError(binding, { models: [], combos: [] })).toContain("tools-capable");
    expect(getComboSearchValidationError(binding, { models: [leaf], getModelCapabilities: () => ({ tools: false }) })).toContain("tools-capable");
    expect(getComboSearchValidationError(null, { kind: "webSearch", models: [] })).toBeNull();
  });
  it("resolves nested combos and rejects missing, disabled, and cyclic paths", () => {
    const combos = [{ name: "child", models: [leaf] }, { name: "middle", models: ["child"] }];
    expect(getComboSearchValidationError(binding, { models: ["middle"], combos })).toBeNull();
    combos[0].isActive = false;
    expect(getComboSearchValidationError(binding, { models: ["middle"], combos })).toBeTruthy();
    expect(getComboSearchValidationError(binding, { models: ["missing"], combos })).toBeTruthy();
    expect(getComboSearchValidationError(binding, { models: ["self"], combos: [{ name: "self", models: ["self"] }] })).toBeTruthy();
  });
});

describe("combo search API and SQLite persistence", () => {
  it("existing/omitted configs are disabled, with an additive nullable JSON column", async () => {
    const response = await create("legacy-search-disabled");
    expect(response.status).toBe(201);
    const combo = await response.json();
    expect(combo.search).toBeNull();
    expect((await getComboById(combo.id)).search).toBeNull();
    const db = await getAdapter();
    expect(db.all("PRAGMA table_info(combos)").find((column) => column.name === "search")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(db.get("SELECT search FROM combos WHERE id = ?", [combo.id]).search).toBeNull();
  });
  it("creates, reads, preserves omitted PUT, replaces and explicitly disables a binding", async () => {
    const response = await create("search-enabled", { search: binding });
    expect(response.status).toBe(201);
    const combo = await response.json();
    expect(combo.search).toEqual(binding);
    expect((await getComboById(combo.id)).search).toEqual(binding);
    const read = await GET(request({}), { params: Promise.resolve({ id: combo.id }) });
    expect((await read.json()).search).toEqual(binding);
    const preserved = await update(combo.id, { groupName: "search" });
    expect(preserved.status).toBe(200);
    expect((await preserved.json()).search).toEqual(binding);
    expect((await update(combo.id, { search: { mode: "gateway", provider: "brave-search" } })).status).toBe(200);
    const disabled = await update(combo.id, { search: null, models: [] });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).search).toBeNull();
    expect((await getComboById(combo.id)).search).toBeNull();
  });
  it("rejects invalid create/update without changing stored binding", async () => {
    for (const extra of [{ search: { ...binding, mode: "native" } }, { search: { ...binding, provider: "openai" } }, { search: binding, kind: "webSearch" }, { search: binding, models: [] }]) {
      expect((await create("invalid-search", extra)).status).toBe(400);
    }
    const combo = await (await create("search-protected", { search: binding })).json();
    for (const patch of [{ search: {} }, { models: [] }, { kind: "webSearch" }, { models: ["search-protected"] }, { search: { ...binding, apiKey: "not-stored" } }]) {
      expect((await update(combo.id, patch)).status).toBe(400);
      expect((await getComboById(combo.id)).search).toEqual(binding);
    }
  });
  it("accepts tools-capable nested targets without binding search to a combo name", async () => {
    expect((await create("search-child")).status).toBe(201);
    expect((await create("search-parent", { models: ["search-child"], search: binding })).status).toBe(201);
    expect((await create("search-not-provider", { search: { ...binding, provider: "search-child" } })).status).toBe(400);
  });
});
