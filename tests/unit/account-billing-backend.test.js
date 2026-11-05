import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { createNodeSqliteAdapter } from "../../src/lib/db/adapters/nodeSqliteAdapter.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.db }));
vi.mock("../../src/lib/db/repos/pricingRepo.js", () => ({
  getPricingForModels: async (pairs) => new Map(pairs.filter((pair) => pair.model === "priced").map((pair) => [`${pair.provider}/${pair.model}`, { input: 1, output: 2 }])),
}));
import { getAccountBilling, setAccountBillingMode, appendAccountBillingEntry, getAccountCosts } from "../../src/lib/db/repos/accountBillingRepo.js";
import { GET as reportGET } from "../../src/app/api/account-costs/route.js";
import { GET, POST, PATCH } from "../../src/app/api/providers/[id]/billing/route.js";

const bill = { id: "9bd3a2e2-9731-4b16-a16e-0abf56d2852a", amount: 30, currency: "USD", paidAt: "2026-01-01T00:00:00Z", startAt: "2026-01-01T00:00:00Z", endAt: "2026-01-31T00:00:00Z" };
const range = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-16T00:00:00.000Z" };
const ctx = (id = "sub") => ({ params: Promise.resolve({ id }) });
const request = (method, body) => new Request("http://localhost/api/providers/sub/billing", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

function connection(id, provider, billingMode) {
  state.db.run("INSERT INTO providerConnections(id, provider, authType, name, data, createdAt, updatedAt) VALUES(?, ?, 'apikey', ?, ?, ?, ?)", [id, provider, `Name ${id}`, JSON.stringify({ ...(billingMode ? { billingMode } : {}), apiKey: "DO_NOT_LEAK", accessToken: "SECRET" }), range.start, range.start]);
}
function usage(id, provider, { model = "priced", timestamp = "2026-01-02T00:00:00.000Z", tokens = { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 30, cache_creation_input_tokens: 10 }, cost = 2 } = {}) {
  state.db.run("INSERT INTO usageHistory(connectionId, provider, model, timestamp, promptTokens, completionTokens, tokens, cost) VALUES(?, ?, ?, ?, 100, 20, ?, ?)", [id, provider, model, timestamp, JSON.stringify(tokens), cost]);
}

describe.each(["node:sqlite", "sql.js"])("account billing backend (%s)", (driver) => {
  let temp;
  beforeEach(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "sm-billing-"));
    state.db = driver === "node:sqlite" ? await createNodeSqliteAdapter(":memory:") : await createSqlJsAdapter(path.join(temp, "test.sqlite"));
    for (const table of ["kv", "providerConnections", "usageHistory"]) state.db.exec(buildCreateTableSql(table, TABLES[table]));
    connection("sub", "qoder");
  });
  afterEach(() => { state.db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

  it("appends immutable bills idempotently and preserves history on mode changes and deletion", async () => {
    await appendAccountBillingEntry("sub", bill);
    await appendAccountBillingEntry("sub", bill);
    expect((await getAccountBilling("sub")).entries).toHaveLength(1);
    await expect(appendAccountBillingEntry("sub", { ...bill, amount: 31 })).rejects.toMatchObject({ status: 409 });
    await Promise.all([
      appendAccountBillingEntry("sub", { ...bill, id: "c5b075f4-6ef1-4d1c-932d-c1c9bc619fac", amount: 10 }),
      setAccountBillingMode("sub", "hybrid"),
    ]);
    expect((await getAccountBilling("sub"))).toMatchObject({ mode: "hybrid", entries: expect.any(Array) });
    expect((await getAccountBilling("sub")).entries).toHaveLength(2);
    const saved = JSON.parse(state.db.get("SELECT data FROM providerConnections WHERE id = 'sub'").data);
    expect(saved).toMatchObject({ billingMode: "hybrid", apiKey: "DO_NOT_LEAK" });
    state.db.run("DELETE FROM providerConnections WHERE id = 'sub'");
    const deleted = await getAccountBilling("sub");
    expect(deleted).toMatchObject({ deleted: true, name: "Name sub", provider: "qoder", mode: "hybrid" });
    expect(deleted.entries).toHaveLength(2);
    expect(await appendAccountBillingEntry("sub", bill)).toBeNull();
  });

  it("aggregates account/model/UTC-day tokens, payments, estimates and deleted/unattributed accounts", async () => {
    for (const mode of ["metered", "hybrid", "free", "unknown"]) connection(mode, "custom", mode);
    connection("idle", "custom", "unknown");
    await appendAccountBillingEntry("sub", bill);
    await appendAccountBillingEntry("sub", { ...bill, id: "c5b075f4-6ef1-4d1c-932d-c1c9bc619fac", paidAt: "2025-12-01T00:00:00Z", startAt: "2025-12-01T00:00:00Z", endAt: "2026-01-01T00:00:00Z" });
    for (const id of ["sub", "metered", "hybrid", "free", "unknown"]) usage(id, id === "sub" ? "qoder" : "custom");
    usage("metered", "custom", { model: "missing", timestamp: "2026-01-03T00:00:00.000Z", tokens: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 10 }, cost: 0 });
    usage("metered", "custom", { timestamp: range.end, cost: 100 }); // exclusive end
    usage("gone", "openai");
    usage(null, "openai", { tokens: {} }); // column fallback
    usage(null, "custom"); // keep providers distinct for unattributed rows
    const report = await getAccountCosts(range);
    const account = (id) => report.accounts.find((item) => item.id === id);
    expect(account("sub")).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 20, cachedTokens: 30, cacheCreationTokens: 10, totalTokens: 120, meteredEstimate: 0, subscriptionPaid: { USD: 30 }, subscriptionAccrued: { USD: 15 } });
    expect(account("sub").entries).toHaveLength(2);
    expect(account("metered")).toMatchObject({ requests: 2, inputTokens: 150, outputTokens: 25, totalTokens: 175, meteredEstimate: 2, unpricedRequests: 1 });
    expect(account("metered").models).toHaveLength(2);
    expect(account("metered").days.map((day) => day.date)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(account("hybrid")).toMatchObject({ meteredEstimate: 2, billingWarning: expect.any(String) });
    expect(account("free").meteredEstimate).toBe(0);
    expect(account("unknown")).toMatchObject({ meteredEstimate: 0, unknownEstimate: 2, billingWarning: expect.any(String) });
    expect(account("gone")).toMatchObject({ deleted: true, billingMode: "metered", meteredEstimate: 2 });
    expect(account("idle").requests).toBe(0);
    expect(report.accounts.filter((item) => item.connectionId === null)).toHaveLength(2);
    expect(report.accounts.find((item) => item.id === "unattributed:openai").deleted).toBe(true);
    expect(report.dayTimezone).toBe("UTC");
    expect(report.totals.requests).toBe(9);
    expect(report.totals.meteredEstimate).toBe(8);
    expect(report.totals.unknownEstimate).toBe(4);
    expect(JSON.stringify(report)).not.toContain("DO_NOT_LEAK");
    expect(JSON.stringify(report)).not.toContain("SECRET");
    const filtered = await getAccountCosts({ ...range, connectionId: "metered" });
    expect(filtered.accounts).toHaveLength(1);
    expect(filtered.totals.requests).toBe(2);
    state.db.run("DELETE FROM providerConnections WHERE id = 'sub'");
    const deleted = await getAccountCosts({ ...range, connectionId: "sub" });
    expect(deleted.accounts[0]).toMatchObject({ name: "Name sub", deleted: true, subscriptionPaid: { USD: 30 } });
  });

  it("flags missing historical prices even when today's model price exists", async () => {
    connection("metered", "custom", "metered");
    usage("metered", "custom", { cost: 0 });
    const report = await getAccountCosts({ ...range, connectionId: "metered" });
    expect(report.accounts[0]).toMatchObject({ unpricedRequests: 1, meteredEstimate: 0 });
  });

  it("fails closed on corrupt ledgers and does not overwrite history", async () => {
    state.db.run("INSERT INTO kv(scope, key, value) VALUES('accountBilling', 'sub', '{}')");
    await expect(appendAccountBillingEntry("sub", bill)).rejects.toThrow(/ledger/);
    expect(state.db.get("SELECT value FROM kv WHERE scope='accountBilling'").value).toBe("{}");
  });

  it("validates HTTP routes and returns contract bodies with no credential fields", async () => {
    expect((await GET(null, ctx())).status).toBe(200);
    expect((await GET(null, ctx("absent"))).status).toBe(404);
    expect((await PATCH(request("PATCH", { mode: "invalid" }), ctx())).status).toBe(400);
    expect((await PATCH(request("PATCH", { mode: "hybrid" }), ctx())).status).toBe(200);
    expect((await POST(request("POST", { ...bill, amount: "30" }), ctx())).status).toBe(400);
    const response = await POST(request("POST", bill), ctx());
    expect(response.status).toBe(200);
    expect((await response.json()).billing).toMatchObject({ mode: "hybrid", entries: [expect.objectContaining({ amount: 30 })] });
    expect((await POST(request("POST", { ...bill, amount: 31 }), ctx())).status).toBe(409);
    expect((await PATCH(request("PATCH", { mode: "free" }), ctx("absent"))).status).toBe(404);
    expect((await reportGET(new Request("http://localhost/api/account-costs?start=bad&end=bad"))).status).toBe(400);
    const report = await reportGET(new Request(`http://localhost/api/account-costs?${new URLSearchParams(range)}`));
    expect(report.status).toBe(200);
    expect((await report.json()).accounts[0].entries).toHaveLength(1);
  });
});
