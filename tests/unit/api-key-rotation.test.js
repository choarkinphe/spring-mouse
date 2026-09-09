import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const hotCache = vi.hoisted(() => new Map());
vi.mock("@/lib/redis/hotCache.js", async (importOriginal) => ({
  ...await importOriginal(),
  getHotJson: vi.fn(async (key) => hotCache.get(key) ?? null),
  setHotJson: vi.fn(async (key, value) => { hotCache.set(key, value); return true; }),
  deleteHotJson: vi.fn(async (key) => hotCache.delete(key)),
}));
process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-rotation-"));

let db;
let repo;
let settingsRepo;
let quota;
let rotate;
let parseApiKey;
let generateApiKeyWithMachine;

beforeAll(async () => {
  const { initDb } = await import("@/lib/db/index.js");
  await initDb();
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
  quota = await import("@/lib/apiKeyQuota.js");
  ({ POST: rotate } = await import("@/app/api/keys/[id]/rotate/route.js"));
  ({ parseApiKey, generateApiKeyWithMachine } = await import("@/shared/utils/apiKey.js"));
});

const requestRotation = (id) => rotate(
  new Request(`http://localhost/api/keys/${id}/rotate`, { method: "POST" }),
  { params: Promise.resolve({ id }) },
);

describe("API key rotation", () => {
  it("replaces the secret, invalidates cached authentication, and keeps metadata and usage", async () => {
    const key = await repo.createApiKey("rotation-test", "machine");
    await repo.updateApiKey(key.id, { quotaMode: "limited" });
    await settingsRepo.updateSettings({
      apiKeyQuotaRules: { fiveHourTokenLimitM: 50, weeklyTokenLimitM: 500 },
      apiKeyAccessTags: { [key.id]: ["team-a"] },
    });
    const completedAt = new Date().toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, 'test', 'test:model', NULL, NULL, ?, 'rotation-usage', ?, ?, NULL, 100000, 0, 0, 'success', '{}', '{}')`,
      [completedAt, key.id, completedAt, completedAt],
    );
    expect(await repo.validateApiKey(key.key)).toBe(true);
    const before = db.get("SELECT * FROM apiKeys WHERE id = ?", [key.id]);
    const quotaBefore = await quota.getApiKeyQuotaStatus(key.key);
    expect(quotaBefore.windows[0].usedTokens).toBe(100000);
    const settingsBefore = await settingsRepo.getSettings();

    const response = await requestRotation(key.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const { key: rotated } = await response.json();
    expect(rotated.key).not.toBe(key.key);
    expect(parseApiKey(rotated.key)).toMatchObject({ machineId: "machine", isNewFormat: true });
    expect(db.get("SELECT * FROM apiKeys WHERE id = ?", [key.id])).toEqual({ ...before, key: rotated.key });
    expect(await settingsRepo.getSettings()).toEqual(settingsBefore);
    expect(await repo.getApiKeyByValue(key.key)).toBeNull();
    expect(await repo.validateApiKey(key.key)).toBe(false);
    expect(await repo.validateApiKey(rotated.key)).toBe(true);
    expect(await quota.getApiKeyQuotaStatus(key.key)).toBeNull();
    expect((await quota.getApiKeyQuotaStatus(rotated.key)).windows).toEqual(quotaBefore.windows);

    const secondResponse = await requestRotation(key.id);
    const { key: secondRotation } = await secondResponse.json();
    expect(secondRotation.key).not.toBe(rotated.key);
    expect(await repo.validateApiKey(rotated.key)).toBe(false);
    expect(await repo.validateApiKey(secondRotation.key)).toBe(true);
  });

  it("does not enable a disabled credential when rotating it", async () => {
    const key = await repo.createApiKey("disabled-rotation", "machine");
    await repo.updateApiKey(key.id, { quotaMode: "off" });
    const response = await requestRotation(key.id);
    expect(response.status).toBe(200);
    const { key: rotated } = await response.json();
    expect(rotated).toMatchObject({ id: key.id, quotaMode: "off", isActive: false });
    expect(await repo.validateApiKey(rotated.key)).toBe(false);
    expect(await repo.validateApiKey(key.key)).toBe(false);
  });

  it("returns 404 without creating a credential for a missing ID", async () => {
    const before = await repo.getApiKeys();
    const response = await requestRotation("missing-key");
    expect(response.status).toBe(404);
    expect(await repo.getApiKeys()).toEqual(before);
  });

  it("uses 128-bit random IDs for new keys and still resolves legacy credentials", async () => {
    const generated = generateApiKeyWithMachine("machine");
    expect(generated.keyId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseApiKey(generated.key)).toMatchObject({ keyId: generated.keyId, machineId: "machine" });
    expect(parseApiKey("sk-legacy123")).toMatchObject({ isNewFormat: false });
    const key = await repo.createApiKey("legacy-rotation", "machine");
    await repo.updateApiKey(key.id, { key: "sk-legacy123" });
    expect(await repo.validateApiKey("sk-legacy123")).toBe(true);
    const response = await requestRotation(key.id);
    expect(response.status).toBe(200);
    expect(await repo.validateApiKey("sk-legacy123")).toBe(false);
    expect(await repo.validateApiKey((await response.json()).key.key)).toBe(true);
  });
});
