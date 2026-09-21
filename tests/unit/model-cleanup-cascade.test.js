import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cascading cleanup for model rows. A channel's `customModels` /
// `modelAliases` / `disabledModels` rows must not outlive the channel: orphans
// inflate /api/models and leak stale ids into pickers.
//
// The hot cache is stubbed out (it is Redis-backed and irrelevant here) so these
// tests run against a real temp SQLite database only.

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-model-cleanup-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.doMock("@/lib/redis/hotCache.js", () => ({
    getHotJson: vi.fn(async () => null),
    setHotJson: vi.fn(async () => true),
    fillHotJson: vi.fn(async () => true),
    deleteHotJson: vi.fn(async () => true),
    incrementHotCounter: vi.fn(async () => 1),
  }));
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seed() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  const put = (scope, key, value) => db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)`,
    [scope, key, JSON.stringify(value)],
  );
  const putAlias = (key, value) => db.run(
    `INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`,
    [key, JSON.stringify(value)],
  );
  return { db, put, putAlias };
}

describe("channel model-row cleanup", () => {
  it("purges every alias form a channel's rows may be stored under", async () => {
    const { put, putAlias } = await seed();
    const cleanup = await import("@/lib/db/modelCleanup.js");

    // codex stores under uiAlias "cx"; a compatible node under its raw id.
    put("customModels", "cx|gpt-5.6-sol|llm", { providerAlias: "cx", id: "gpt-5.6-sol", type: "llm" });
    put("customModels", "codex|legacy-id|llm", { providerAlias: "codex", id: "legacy-id", type: "llm" });
    putAlias("sol", "cx/gpt-5.6-sol");
    putAlias("legacy", "codex/legacy-id");
    put("disabledModels", "cx", ["gpt-5.6-luna"]);

    // An unrelated channel must survive.
    put("customModels", "ds|deepseek-v4|llm", { providerAlias: "ds", id: "deepseek-v4", type: "llm" });
    putAlias("ds-model", "ds/deepseek-v4");
    put("disabledModels", "ds", ["deepseek-v4"]);

    const removed = await cleanup.purgeChannelModelRowsByProviderId("codex");

    expect(removed).toEqual({ customModels: 2, modelAliases: 2, disabledModels: 1 });

    const { getCustomModels, getModelAliases } = await import("@/lib/db/repos/aliasRepo.js");
    const { getDisabledModels } = await import("@/lib/db/repos/disabledModelsRepo.js");
    expect((await getCustomModels()).map((m) => m.id)).toEqual(["deepseek-v4"]);
    expect(Object.keys(await getModelAliases())).toEqual(["ds-model"]);
    expect(Object.keys(await getDisabledModels())).toEqual(["ds"]);
  });

  it("matches a compatible channel by its node id and stored prefix", async () => {
    const { put, putAlias } = await seed();
    const cleanup = await import("@/lib/db/modelCleanup.js");
    const nodeId = "openai-compatible-chat-aaaa-bbbb";

    put("customModels", `${nodeId}|qwen3.8-max|llm`, { providerAlias: nodeId, id: "qwen3.8-max", type: "llm" });
    // Older rows may have been written under the display prefix instead.
    put("customModels", "千问|stale-model|llm", { providerAlias: "千问", id: "stale-model", type: "llm" });
    putAlias("qwen", `${nodeId}/qwen3.8-max`);

    const removed = await cleanup.purgeChannelModelRowsByProviderId(nodeId, { prefix: "千问" });

    expect(removed.customModels).toBe(2);
    expect(removed.modelAliases).toBe(1);
  });

  it("does not treat a LIKE metacharacter in an alias as a wildcard", async () => {
    const { put } = await seed();
    const cleanup = await import("@/lib/db/modelCleanup.js");

    put("customModels", "a_b|keep-me|llm", { providerAlias: "a_b", id: "keep-me", type: "llm" });
    put("customModels", "axb|other|llm", { providerAlias: "axb", id: "other", type: "llm" });

    await cleanup.purgeChannelModelRows(["a_b"]);

    const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
    expect((await getCustomModels()).map((m) => m.id)).toEqual(["other"]);
  });

  it("sweeps rows whose channel is gone, keeping live channels and disabled ones", async () => {
    const { put, putAlias } = await seed();
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    const cleanup = await import("@/lib/db/modelCleanup.js");

    // A live channel (even with a disabled connection) keeps its rows.
    await createProviderConnection({ provider: "deepseek", authType: "apikey", name: "ds", apiKey: "k", isActive: false });
    put("customModels", "ds|deepseek-v4|llm", { providerAlias: "ds", id: "deepseek-v4", type: "llm" });
    putAlias("live", "ds/deepseek-v4");

    // Orphans: the owning channel no longer exists.
    put("customModels", "cx|gone-model|llm", { providerAlias: "cx", id: "gone-model", type: "llm" });
    put("customModels", "dead-node|gone-2|llm", { providerAlias: "dead-node", id: "gone-2", type: "llm" });
    putAlias("orphan", "cx/gone-model");
    put("disabledModels", "cx", ["gone-model"]);

    const dry = await cleanup.purgeOrphanedModelRows({ dryRun: true });
    expect(dry).toEqual({ customModels: 2, modelAliases: 1, disabledModels: 1, deleted: false });

    const swept = await cleanup.purgeOrphanedModelRows();
    expect(swept).toEqual({ customModels: 2, modelAliases: 1, disabledModels: 1, deleted: true });

    const { getCustomModels, getModelAliases } = await import("@/lib/db/repos/aliasRepo.js");
    expect((await getCustomModels()).map((m) => m.id)).toEqual(["deepseek-v4"]);
    expect(Object.keys(await getModelAliases())).toEqual(["live"]);
  });

  it("keeps rows that name a providerId even when providerAlias is absent", async () => {
    const { put } = await seed();
    const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
    const cleanup = await import("@/lib/db/modelCleanup.js");

    const node = await createProviderNode({ id: "openai-compatible-chat-live", type: "openai-compatible", name: "Live", prefix: "live", baseUrl: "https://x/v1" });
    put("customModels", `${node.id}|m|llm`, { providerId: node.id, id: "m", type: "llm" });

    const swept = await cleanup.purgeOrphanedModelRows();
    expect(swept.customModels).toBe(0);

    const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
    expect((await getCustomModels()).map((m) => m.id)).toEqual(["m"]);
  });

  it("refuses to sweep when no channels exist at all", async () => {
    // With zero connections/nodes every row looks orphaned; deleting would wipe
    // the user's model config on a transient empty read (fresh install, import).
    const { put, putAlias } = await seed();
    const cleanup = await import("@/lib/db/modelCleanup.js");

    put("customModels", "cx|keep|llm", { providerAlias: "cx", id: "keep", type: "llm" });
    putAlias("keep", "cx/keep");

    const swept = await cleanup.purgeOrphanedModelRows();
    expect(swept.skipped).toBe("no channels");
    expect(swept.customModels).toBe(0);

    const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
    expect((await getCustomModels()).map((m) => m.id)).toEqual(["keep"]);
  });
});
