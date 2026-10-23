import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Migration 027 moves saved CodeBuddy accounts to the WorkBuddy provider ids
 * without re-authorizing. These tests focus on what must survive: credentials,
 * the CN UID, unrelated keys, unrelated providers, and any row the migration
 * cannot parse. They also pin the deliberate non-goal — model strings keep their
 * `cbcn/` / `cbai/` prefixes because the WorkBuddy registry keeps those aliases.
 */

let tempDir;
let migration;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-mig027-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  migration = (await import("../../src/lib/db/migrations/027-codebuddy-to-workbuddy.js")).default;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const NOW = "2026-08-01T00:00:00.000Z";

async function freshDb() {
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  return getAdapter();
}

function insertConnection(db, { id, provider, authType = "oauth", data }) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, mouseId, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, provider, authType, id, null, null, null, 1, typeof data === "string" ? data : JSON.stringify(data), NOW, NOW],
  );
}

function readConnection(db, id) {
  const row = db.get(`SELECT provider, data FROM providerConnections WHERE id = ?`, [id]);
  return { provider: row.provider, data: JSON.parse(row.data) };
}

function insertKv(db, scope, key, value) {
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)`,
    [scope, key, typeof value === "string" ? value : JSON.stringify(value)],
  );
}

function kvKeys(db, scope) {
  return db.all(`SELECT key FROM kv WHERE scope = ? ORDER BY key`, [scope]).map((row) => row.key);
}

function readSettings(db) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? row.data : null;
}

function insertSettings(db, data) {
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [typeof data === "string" ? data : JSON.stringify(data)],
  );
}

describe("migration 027: codebuddy → workbuddy", () => {
  it("renames a CN account and adds the WorkBuddy binding while preserving every existing key", async () => {
    const db = await freshDb();
    insertConnection(db, {
      id: "cn-1",
      provider: "codebuddy-cn",
      data: {
        accessToken: "access-cn",
        refreshToken: "refresh-cn",
        expiresAt: "2026-09-01T00:00:00.000Z",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:7890",
        providerSpecificData: {
          codebuddyUid: "cn-uid-1",
          maxConcurrentStreams: 2,
          modelLock_glm: { until: 1 },
          lastError: "boom",
          lastErrorAt: NOW,
        },
      },
    });

    migration.up(db);

    const { provider, data } = readConnection(db, "cn-1");
    expect(provider).toBe("workbuddy");
    expect(data.accessToken).toBe("access-cn");
    expect(data.refreshToken).toBe("refresh-cn");
    expect(data.connectionProxyEnabled).toBe(true);
    expect(data.connectionProxyUrl).toBe("http://127.0.0.1:7890");
    expect(data.providerSpecificData).toEqual({
      codebuddyUid: "cn-uid-1",
      maxConcurrentStreams: 2,
      modelLock_glm: { until: 1 },
      lastError: "boom",
      lastErrorAt: NOW,
      workbuddyProduct: "workbuddy",
      workbuddyOrigin: "https://copilot.tencent.com",
      workbuddyPlatform: "workbuddy",
      workbuddyContract: "0.1.30",
      domain: "copilot.tencent.com",
      // CN credentials are legacy too: they keep the CodeBuddy request
      // transform/refresh they had before the rename, so production accounts
      // that worked before the upgrade still work without re-authorizing.
      workbuddyLegacyCredential: true,
      workbuddyLegacyOrigin: "https://copilot.tencent.com",
      workbuddyEndpointOrigin: "https://copilot.tencent.com",
    });
    expect(data.providerSpecificData.workbuddyLegacyOrigin).toBe("https://copilot.tencent.com");
  });

  it("renames an international account and marks it legacy on the old origin only", async () => {
    const db = await freshDb();
    insertConnection(db, {
      id: "intl-1",
      provider: "codebuddy-intl",
      data: {
        accessToken: "access-intl",
        providerSpecificData: { connectionProxyEnabled: false },
      },
    });
    insertConnection(db, {
      id: "intl-apikey",
      provider: "codebuddy-intl",
      authType: "apikey",
      data: {
        apiKey: "sk-intl",
        providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" },
      },
    });

    migration.up(db);

    for (const id of ["intl-1", "intl-apikey"]) {
      const { provider, data } = readConnection(db, id);
      expect(provider).toBe("workbuddy-ai");
      expect(data.providerSpecificData).toMatchObject({
        workbuddyProduct: "workbuddy-ai",
        workbuddyOrigin: "https://www.workbuddy.ai",
        workbuddyPlatform: "workbuddy-ai",
        workbuddyContract: "0.1.30",
        workbuddyLegacyCredential: true,
        workbuddyLegacyOrigin: "https://www.codebuddy.ai",
        workbuddyEndpointOrigin: "https://www.codebuddy.ai",
      });
    }
    // The api-key row keeps its credential and proxy settings.
    const apiKeyRow = readConnection(db, "intl-apikey");
    expect(apiKeyRow.data.apiKey).toBe("sk-intl");
    expect(apiKeyRow.data.providerSpecificData.connectionProxyEnabled).toBe(true);
    expect(apiKeyRow.data.providerSpecificData.connectionProxyUrl).toBe("http://127.0.0.1:7890");

    // The legacy marker belongs to the international rename, never the CN one.
    insertConnection(db, {
      id: "cn-2",
      provider: "codebuddy-cn",
      data: { providerSpecificData: { codebuddyUid: "cn-uid-2" } },
    });
    migration.up(db);
    const cn = readConnection(db, "cn-2");
    expect(cn.provider).toBe("workbuddy");
    expect(cn.data.providerSpecificData.workbuddyLegacyCredential).toBe(true);
    expect(cn.data.providerSpecificData.workbuddyEndpointOrigin).toBe("https://copilot.tencent.com");
  });

  it("never invents a UID — an account without one migrates without the key", async () => {
    const db = await freshDb();
    insertConnection(db, {
      id: "intl-nouid",
      provider: "codebuddy-intl",
      data: { accessToken: "access-intl", providerSpecificData: {} },
    });
    insertConnection(db, {
      id: "cn-no-pdata",
      provider: "codebuddy-cn",
      data: { accessToken: "access-cn" },
    });

    migration.up(db);

    const intl = readConnection(db, "intl-nouid");
    expect(intl.provider).toBe("workbuddy-ai");
    expect(intl.data.providerSpecificData).not.toHaveProperty("codebuddyUid");

    // A row with no providerSpecificData at all gets the binding but no UID.
    const cn = readConnection(db, "cn-no-pdata");
    expect(cn.provider).toBe("workbuddy");
    expect(cn.data.providerSpecificData).not.toHaveProperty("codebuddyUid");
    expect(cn.data.providerSpecificData.workbuddyProduct).toBe("workbuddy");
  });

  it("leaves unparseable rows and non-object metadata untouched", async () => {
    const db = await freshDb();
    insertConnection(db, { id: "broken", provider: "codebuddy-cn", data: '{"accessToken": "x",' });
    insertConnection(db, {
      id: "odd-blob",
      provider: "codebuddy-intl",
      data: { accessToken: "x", providerSpecificData: "corrupt" },
    });

    migration.up(db);

    const broken = db.get(`SELECT provider, data FROM providerConnections WHERE id = 'broken'`);
    expect(broken.provider).toBe("codebuddy-cn");
    expect(broken.data).toBe('{"accessToken": "x",');

    const odd = db.get(`SELECT provider, data FROM providerConnections WHERE id = 'odd-blob'`);
    expect(odd.provider).toBe("codebuddy-intl");
    expect(JSON.parse(odd.data).providerSpecificData).toBe("corrupt");
  });

  it("does not rewrite model prefixes in combos or settings", async () => {
    const db = await freshDb();
    const comboModels = ["cbcn/glm-5.2", { model: "cbai/claude-sonnet", accessTags: ["vip"] }];
    const comboModelsJson = JSON.stringify(comboModels);
    db.run(
      `INSERT INTO combos(id, name, kind, models, isActive, groupName, sortOrder, capabilities, search, accessTags, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, 1, NULL, 0, '{}', NULL, '[]', ?, ?)`,
      ["c1", "daily", null, comboModelsJson, NOW, NOW],
    );

    const settings = {
      modelAliases: { "cbcn/glm-5.2": "cbcn/glm-5.2", fast: "cbai/quick" },
      defaultModel: "cbcn/glm-5.2",
      modelAccessTags: { "cbcn/glm-5.2": ["vip"], "cbai/quick": ["team"] },
      harnessProfiles: { "claude-code": { model: "cbcn/glm-5.2" } },
      apiKeyAccessTags: { key1: ["vip"] },
      unrelated: "cbcn/ is not a model here even though it mentions cbcn/",
    };
    const settingsJson = JSON.stringify(settings);
    insertSettings(db, settingsJson);

    migration.up(db);

    const combo = db.get(`SELECT models FROM combos WHERE id = 'c1'`);
    expect(combo.models).toBe(comboModelsJson);
    expect(readSettings(db)).toBe(settingsJson);
  });

  it("leaves malformed settings JSON byte-for-byte intact", async () => {
    const db = await freshDb();
    const malformed = '{"modelAliases": {"cbcn/x": "cbcn/y"},';
    insertSettings(db, malformed);

    migration.up(db);

    expect(readSettings(db)).toBe(malformed);
  });

  it("moves UID-keyed check-in rows and leaves per-connection switches alone", async () => {
    const db = await freshDb();
    const state = { status: "success", lastSuccessDate: "2026-07-31", reward: 3, leaseUntil: 5, leaseId: "L" };
    insertKv(db, "codebuddyCheckin", "account:codebuddy-cn:uid-1", state);
    insertKv(db, "codebuddyCheckin", "account:codebuddy-cn:uid-2", { status: "error", lastAttemptAt: NOW });
    insertKv(db, "codebuddyCheckin", "conn-1", { enabled: true });
    insertKv(db, "codebuddyCheckin", "conn-2", { enabled: false });

    migration.up(db);

    expect(kvKeys(db, "codebuddyCheckin")).toEqual([
      "account:workbuddy:uid-1",
      "account:workbuddy:uid-2",
      "conn-1",
      "conn-2",
    ]);
    expect(JSON.parse(db.get(`SELECT value FROM kv WHERE scope='codebuddyCheckin' AND key='account:workbuddy:uid-1'`).value)).toEqual(state);
    expect(JSON.parse(db.get(`SELECT value FROM kv WHERE scope='codebuddyCheckin' AND key='conn-1'`).value)).toEqual({ enabled: true });
    expect(JSON.parse(db.get(`SELECT value FROM kv WHERE scope='codebuddyCheckin' AND key='conn-2'`).value)).toEqual({ enabled: false });
  });

  it("keeps the newer row when both the old and new check-in keys exist", async () => {
    const db = await freshDb();
    insertKv(db, "codebuddyCheckin", "account:codebuddy-cn:uid-1", {
      status: "success", lastSuccessDate: "2026-07-30", reward: 1,
    });
    insertKv(db, "codebuddyCheckin", "account:workbuddy:uid-1", {
      status: "success", lastSuccessDate: "2026-08-02", reward: 2,
    });

    migration.up(db);

    expect(kvKeys(db, "codebuddyCheckin")).toEqual(["account:workbuddy:uid-1"]);
    const kept = JSON.parse(db.get(`SELECT value FROM kv WHERE scope='codebuddyCheckin' AND key='account:workbuddy:uid-1'`).value);
    // The already-migrated row is the newer, edited one and must survive.
    expect(kept).toEqual({ status: "success", lastSuccessDate: "2026-08-02", reward: 2 });
  });

  it("lets a provably newer legacy check-in row win over an older new-key row", async () => {
    const db = await freshDb();
    insertKv(db, "codebuddyCheckin", "account:codebuddy-cn:uid-1", {
      status: "success", lastSuccessDate: "2026-08-03", reward: 9,
    });
    insertKv(db, "codebuddyCheckin", "account:workbuddy:uid-1", {
      status: "success", lastSuccessDate: "2026-07-01", reward: 1,
    });

    migration.up(db);

    const kept = JSON.parse(db.get(`SELECT value FROM kv WHERE scope='codebuddyCheckin' AND key='account:workbuddy:uid-1'`).value);
    expect(kept).toEqual({ status: "success", lastSuccessDate: "2026-08-03", reward: 9 });
  });

  it("is idempotent — a second run changes nothing", async () => {
    const db = await freshDb();
    insertConnection(db, {
      id: "cn-1",
      provider: "codebuddy-cn",
      data: { accessToken: "a", providerSpecificData: { codebuddyUid: "u1" } },
    });
    insertConnection(db, {
      id: "intl-1",
      provider: "codebuddy-intl",
      data: { accessToken: "b", providerSpecificData: {} },
    });
    insertKv(db, "codebuddyCheckin", "account:codebuddy-cn:uid-1", { status: "success" });
    insertKv(db, "codebuddyCheckin", "conn-1", { enabled: true });

    const snapshot = () => JSON.stringify({
      connections: db.all(`SELECT * FROM providerConnections ORDER BY id`),
      kv: db.all(`SELECT * FROM kv ORDER BY scope, key`),
    });

    migration.up(db);
    const afterFirst = snapshot();
    migration.up(db);

    expect(snapshot()).toBe(afterFirst);
    expect(db.all(`SELECT id FROM providerConnections WHERE provider LIKE 'codebuddy-%'`)).toEqual([]);
    expect(kvKeys(db, "codebuddyCheckin")).toEqual(["account:workbuddy:uid-1", "conn-1"]);
  });

  it("does not touch other providers or other kv scopes", async () => {
    const db = await freshDb();
    insertConnection(db, {
      id: "other",
      provider: "codex",
      data: { accessToken: "x", providerSpecificData: { codebuddyUid: "not-ours" } },
    });
    insertKv(db, "modelAliases", "cbcn/glm-5.2", "cbcn/glm-5.2");
    insertKv(db, "codebuddyCheckin", "account:codebuddy-intl:uid-9", { status: "success" });

    migration.up(db);

    const other = readConnection(db, "other");
    expect(other.provider).toBe("codex");
    expect(other.data.providerSpecificData).toEqual({ codebuddyUid: "not-ours" });

    expect(kvKeys(db, "modelAliases")).toEqual(["cbcn/glm-5.2"]);
    // International accounts never had check-in state; an unexpected key is left
    // exactly where it is rather than guessed about.
    expect(kvKeys(db, "codebuddyCheckin")).toEqual(["account:codebuddy-intl:uid-9"]);
  });
});
