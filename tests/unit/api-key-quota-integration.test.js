import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-quota-"));

let db;
let getAdapter;
let initDb;
let createApiKey;
let getApiKeyQuotaStatuses;
let checkApiKeyQuota;
let getApiKeyQuotaStatus;
let invalidateQuotaCache;
let updateSettings;
let codexUsageRoute;
let keysRoute;
let validateApiKey;

beforeAll(async () => {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ initDb } = await import("@/lib/db/index.js"));
  ({ createApiKey, validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js"));
  ({ updateSettings } = await import("@/lib/db/repos/settingsRepo.js"));
  ({ getApiKeyQuotaStatuses, getApiKeyQuotaStatus, checkApiKeyQuota, invalidateQuotaCache } = await import("@/lib/apiKeyQuota.js"));
  codexUsageRoute = await import("@/app/api/codex/usage/route.js");
  keysRoute = await import("@/app/api/keys/[id]/route.js");
  await initDb();
  db = await getAdapter();
});

describe("API key quota persistence", () => {
  it("computes and enforces quota from persisted successful usage", async () => {
    const key = await createApiKey("quota-test", "machine");
    db.run(`UPDATE apiKeys SET quotaMode = 'limited' WHERE id = ?`, [key.id]);
    await updateSettings({ apiKeyQuotaRules: { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 10 } });
    const completedAt = new Date().toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL, 900000, 600000, 1.5, 'success', '{}', '{}')`,
      [completedAt, "test", "test:model", key.id, completedAt, completedAt],
    );

    const statuses = await getApiKeyQuotaStatuses();
    const fiveHour = statuses[key.id].windows.find((window) => window.id === "fiveHour");
    expect(fiveHour).toMatchObject({ usedM: 1.5, usedTokens: 1_500_000, limitM: 2, exceeded: false });

    db.run(`UPDATE apiKeys SET key = ? WHERE id = ?`, [`${key.key}-overflow`, key.id]);
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL, 450000, 300000, 0.75, 'success', '{}', '{}')`,
      [completedAt, "test", "test:model", key.id, completedAt, completedAt],
    );
    const overflowKey = `${key.key}-overflow`;
    const decision = await checkApiKeyQuota(overflowKey);
    expect(decision).toMatchObject({ applies: true, allowed: false });
    expect(decision.status.exceededWindow.id).toBe("fiveHour");

    await keysRoute.PUT(
      new Request(`http://localhost/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetQuota: true }),
      }),
      { params: { id: key.id } },
    );
    const resetDecision = await checkApiKeyQuota(overflowKey);
    expect(resetDecision).toMatchObject({ applies: true, allowed: true });
    expect(resetDecision.status.windows.every((window) => window.usedTokens === 0)).toBe(true);

    const response = await codexUsageRoute.GET(new Request("http://localhost/codex/usage", {
      headers: { Authorization: `Bearer ${overflowKey}` },
    }));
    await expect(response.json()).resolves.toEqual({
      rate_limits: {
        primary: { used_percent: 0, window_minutes: 300 },
        secondary: { used_percent: 0, window_minutes: 10080 },
      },
    });
  });
});

describe("API key quota window resets", () => {
  it("resets the five-hour and weekly windows independently", async () => {
    const key = await createApiKey("independent-reset", "machine");
    await updateSettings({ apiKeyQuotaRules: { fiveHourTokenLimitM: 3, weeklyTokenLimitM: 2.2 } });
    db.run(`UPDATE apiKeys SET quotaMode = 'limited' WHERE id = ?`, [key.id]);

    const oneHourAgo = new Date().toISOString();
    const sixHoursAgo = oneHourAgo;
    const insertUsage = (requestId, completedAt, tokens) => db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, 0, 0, 'success', '{}', '{}')`,
      [completedAt, "test", "test:model", key.id, requestId, completedAt, completedAt, tokens],
    );
    insertUsage("five-hour-usage", oneHourAgo, 1_500_000);
    insertUsage("weekly-only-usage", sixHoursAgo, 1_000_000);

    let decision = await checkApiKeyQuota(key.key);
    expect(decision).toMatchObject({ applies: true, allowed: false });
    expect(decision.status.exceededWindow.id).toBe("weekly");

    const response = await keysRoute.PUT(
      new Request(`http://localhost/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetQuotaWindow: "weekly" }),
      }),
      { params: { id: key.id } },
    );
    await expect(response.json()).resolves.toMatchObject({
      key: { weeklyQuotaResetAt: expect.any(String), fiveHourQuotaResetAt: expect.any(String) },
    });

    decision = await checkApiKeyQuota(key.key);
    expect(new Date(decision.status.windows.find((window) => window.id === "weekly").resetAt).getTime()).toBeGreaterThan(Date.now());

    await keysRoute.PUT(
      new Request(`http://localhost/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetQuotaWindow: "fiveHour" }),
      }),
      { params: { id: key.id } },
    );
    decision = await checkApiKeyQuota(key.key);
    expect(decision.status.windows.every((window) => window.usedTokens === 0)).toBe(true);
  });

  it("advances a missed scheduled reset before calculating quota", async () => {
    const key = await createApiKey("scheduled-reset", "machine");
    await updateSettings({ apiKeyQuotaRules: { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 20 } });
    db.run(`UPDATE apiKeys SET quotaMode = 'limited' WHERE id = ?`, [key.id]);
    const overdueResetAt = new Date(Date.now() - 1_000).toISOString();
    const completedInPreviousWindow = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.run(`UPDATE apiKeys SET fiveHourQuotaResetAt = ? WHERE id = ?`, [overdueResetAt, key.id]);
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, 1500000, 0, 0, 'success', '{}', '{}')`,
      [completedInPreviousWindow, "test", "test:model", key.id, "scheduled-reset-previous-window", completedInPreviousWindow, completedInPreviousWindow],
    );
    const status = await getApiKeyQuotaStatus(key.key);
    const fiveHour = status.windows.find((window) => window.id === "fiveHour");
    expect(fiveHour.usedTokens).toBe(0);
    expect(new Date(fiveHour.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("reuses quota status until the cache is explicitly invalidated", async () => {
    const key = await createApiKey("cached-status", "machine");
    await updateSettings({ apiKeyQuotaRules: { fiveHourTokenLimitM: 2, weeklyTokenLimitM: 20 } });
    db.run(`UPDATE apiKeys SET quotaMode = 'limited' WHERE id = ?`, [key.id]);

    const before = await getApiKeyQuotaStatus(key.key);
    const completedAt = new Date().toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, 500000, 0, 0, 'success', '{}', '{}')`,
      [completedAt, "test", "test:model", key.id, "cached-status-usage", completedAt, completedAt],
    );

    const cached = await getApiKeyQuotaStatus(key.key);
    expect(cached).toBe(before);
    expect(cached.windows.find((window) => window.id === "fiveHour").usedTokens).toBe(0);

    invalidateQuotaCache(key.key);
    const refreshed = await getApiKeyQuotaStatus(key.key);
    expect(refreshed.windows.find((window) => window.id === "fiveHour").usedTokens).toBe(500_000);
  });

  it("treats the off mode as disabled authentication", async () => {
    const key = await createApiKey("off-mode", "machine");
    expect(await validateApiKey(key.key)).toBe(true);

    await keysRoute.PUT(
      new Request(`http://localhost/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaMode: "off" }),
      }),
      { params: { id: key.id } },
    );
    expect(await validateApiKey(key.key)).toBe(false);

    await keysRoute.PUT(
      new Request(`http://localhost/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaMode: "limited" }),
      }),
      { params: { id: key.id } },
    );
    expect(await validateApiKey(key.key)).toBe(true);
  });
});
