import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-model-quota-"));
// Quota counters only populate when Redis is configured; leaving it unset makes
// every read fall back to the SQLite aggregate, which is the path this exercises.
delete process.env.SPRING_MOUSE_REDIS_URL;

let db;
let initDb;
let getAdapter;
let createApiKey;
let updateSettings;
let updateApiKey;
let getApiKeyQuotaStatuses;
let checkModelQuotaForRequest;
let saveRequestUsage;
let keysRoute;

const GROUPS = [
  {
    id: "premium",
    label: "高阶模型",
    models: ["claude-opus*"],
    fiveHourTokenLimitM: 1,
    weeklyTokenLimitM: 10,
    fallback: "anthropic/claude-sonnet-4-5",
  },
];

beforeAll(async () => {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ initDb } = await import("@/lib/db/index.js"));
  ({ createApiKey, updateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js"));
  ({ updateSettings } = await import("@/lib/db/repos/settingsRepo.js"));
  ({ getApiKeyQuotaStatuses, checkModelQuotaForRequest } = await import("@/lib/apiKeyQuota.js"));
  ({ saveRequestUsage } = await import("@/lib/usageDb.js"));
  keysRoute = await import("@/app/api/keys/[id]/route.js");
  await initDb();
  db = await getAdapter();
});

beforeEach(async () => {
  db.run(`DELETE FROM usageHistory`);
  await updateSettings({ apiKeyModelQuotaRules: { enabled: true, groups: GROUPS } });
});

function insertUsage(apiKeyId, requestId, { provider = "anthropic", model = "claude-opus-5", tokens = 400_000, completedAt = new Date().toISOString() } = {}) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES(?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, 0, 0, 'success', '{}', '{}')`,
    [completedAt, provider, model, apiKeyId, requestId, completedAt, completedAt, tokens],
  );
}

describe("per-model quota enforcement", () => {
  it("allows a claimed model while it is under its window and blocks it once spent", async () => {
    const key = await createApiKey("premium-key", "machine");
    insertUsage(key.id, "u1", { tokens: 400_000 });

    let decision = await checkModelQuotaForRequest(key.key, { provider: "anthropic", model: "claude-opus-5" });
    expect(decision).toMatchObject({ applies: true, allowed: true });
    expect(decision.group.id).toBe("premium");

    insertUsage(key.id, "u2", { tokens: 700_000 });
    // The status is cached per key for 10s; a real request arrives well after
    // the write that invalidated it, but a test writes and reads in one tick.
    const { invalidateQuotaCache } = await import("@/lib/apiKeyQuotaCache.js");
    invalidateQuotaCache(key.key);
    decision = await checkModelQuotaForRequest(key.key, { provider: "anthropic", model: "claude-opus-5" });
    expect(decision).toMatchObject({ applies: true, allowed: false });
    expect(decision.group.exceededWindow.id).toBe("fiveHour");
    // The configured downgrade target travels with the decision.
    expect(decision.fallback).toBe("anthropic/claude-sonnet-4-5");
  });

  it("leaves models no group claims alone", async () => {
    const key = await createApiKey("free-key", "machine");
    insertUsage(key.id, "u3", { model: "claude-haiku-4", tokens: 5_000_000 });
    await expect(checkModelQuotaForRequest(key.key, { provider: "anthropic", model: "claude-haiku-4" }))
      .resolves.toMatchObject({ applies: false, allowed: true });
  });

  it("keeps the group independent of a whole-key quota the key has not opted into", async () => {
    const key = await createApiKey("unlimited-key", "machine");
    db.run(`UPDATE apiKeys SET quotaMode = 'unlimited' WHERE id = ?`, [key.id]);
    insertUsage(key.id, "u4", { tokens: 1_000_000 });

    const statuses = await getApiKeyQuotaStatuses();
    expect(statuses[key.id].enabled).toBe(false);
    expect(statuses[key.id].exceededWindow).toBeNull();
    // ...but the premium group is still spent, which is the entire point of a
    // per-model limit.
    expect(statuses[key.id].exceededModelGroup.id).toBe("premium");
    await expect(checkModelQuotaForRequest(key.key, { provider: "anthropic", model: "claude-opus-5" }))
      .resolves.toMatchObject({ applies: true, allowed: false });
  });

  it("applies a per-key override and goes back to the global limit when cleared", async () => {
    const key = await createApiKey("override-key", "machine");
    insertUsage(key.id, "u5", { tokens: 600_000 });

    await expect(checkModelQuotaForRequest(key.key, { provider: "anthropic", model: "claude-opus-5" }))
      .resolves.toMatchObject({ applies: true, allowed: true });

    await keysRoute.PUT(
      new Request(`http://localhost/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelQuotaOverrides: { premium: { fiveHourTokenLimitM: 0.5 } } }),
      }),
      { params: { id: key.id } },
    );
    await expect(checkModelQuotaForRequest(key.key, { provider: "anthropic", model: "claude-opus-5" }))
      .resolves.toMatchObject({ applies: true, allowed: false });

    await keysRoute.PUT(
      new Request(`http://localhost/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelQuotaOverrides: {} }),
      }),
      { params: { id: key.id } },
    );
    const stored = await updateApiKey(key.id, {});
    expect(stored.modelQuotaOverrides).toEqual({});
    await expect(checkModelQuotaForRequest(key.key, { provider: "anthropic", model: "claude-opus-5" }))
      .resolves.toMatchObject({ applies: true, allowed: true });
  });

  it("charges a usage write to the group and reflects it immediately", async () => {
    const key = await createApiKey("write-key", "machine");
    for (const index of [1, 2, 3]) {
      await saveRequestUsage({
        requestId: `write-${index}`,
        provider: "anthropic",
        model: "claude-opus-5",
        apiKey: key.key,
        tokens: { prompt_tokens: 200_000, completion_tokens: 100_000 },
        status: "success",
        startedAt: new Date().toISOString(),
      });
    }
    const statuses = await getApiKeyQuotaStatuses();
    const premium = statuses[key.id].modelGroups.find((group) => group.id === "premium");
    expect(premium.windows.find((window) => window.id === "fiveHour").usedTokens).toBe(900_000);
    expect(premium.exceededWindow).toBeNull();

    await saveRequestUsage({
      requestId: "write-4",
      provider: "anthropic",
      model: "claude-opus-5",
      apiKey: key.key,
      tokens: { prompt_tokens: 200_000, completion_tokens: 0 },
      status: "success",
      startedAt: new Date().toISOString(),
    });
    const after = await getApiKeyQuotaStatuses();
    expect(after[key.id].modelGroups.find((group) => group.id === "premium").exceededWindow.id).toBe("fiveHour");
  });

  it("does not charge a failed request", async () => {
    const key = await createApiKey("failed-key", "machine");
    await saveRequestUsage({
      requestId: "failed-1",
      provider: "anthropic",
      model: "claude-opus-5",
      apiKey: key.key,
      tokens: { prompt_tokens: 5_000_000, completion_tokens: 0 },
      status: "upstream:500",
      startedAt: new Date().toISOString(),
    });
    const statuses = await getApiKeyQuotaStatuses();
    expect(statuses[key.id].modelGroups.find((group) => group.id === "premium").windows[0].usedTokens).toBe(0);
  });

  it("rejects a settings update whose downgrade target is neither a model nor a combo", async () => {
    const settingsRoute = await import("@/app/api/settings/route.js");
    const response = await settingsRoute.PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKeyModelQuotaRules: {
          groups: [{ id: "premium", label: "高阶模型", models: ["x*"], fiveHourTokenLimitM: 1, fallback: "no-such-combo" }],
        },
      }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("降级目标") });

    const ok = await settingsRoute.PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKeyModelQuotaRules: {
          groups: [{ id: "premium", label: "高阶模型", models: ["x*"], fiveHourTokenLimitM: 1, fallback: "anthropic/claude-haiku-4" }],
        },
      }),
    }));
    expect(ok.status).toBe(200);
  });
});
