import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];
const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

async function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-usage-writer-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "db"));
  const file = path.join(dir, "db", "data.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE usageHistory(
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT,
      connectionId TEXT, apiKey TEXT, apiKeyId TEXT, requestId TEXT, trafficRequestId TEXT,
      startedAt TEXT, completedAt TEXT, endpoint TEXT, promptTokens INTEGER,
      completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT, meta TEXT
    );
    CREATE TABLE apiKeys(id TEXT PRIMARY KEY, lastUsedAt TEXT);
    CREATE TABLE _meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO apiKeys(id) VALUES('key-1');
    INSERT INTO _meta(key,value) VALUES('totalRequestsLifetime','0');
  `);
  db.close();
  process.env.DATA_DIR = dir;
  process.env.SPRING_MOUSE_USAGE_WRITER_TEST = "true";
  vi.resetModules();
  const { __test__ } = await import("../../runtime/usage-writer.mjs");
  return { file, persistBatch: __test__.persistBatch };
}

function event(overrides = {}) {
  return {
    requestId: "request-1", timestamp: "2026-11-08T01:00:00.000Z",
    startedAt: "2026-11-08T01:00:00.000Z", completedAt: "2026-11-08T01:00:01.000Z",
    provider: "codex", model: "gpt-test", connectionId: "connection-1",
    apiKeyId: "key-1", knownApiKeyId: "key-1", endpoint: "/v1/chat/completions",
    promptTokens: 10, completionTokens: 5, cost: 0, status: "success",
    ...overrides,
  };
}

describe("usage writer transaction recovery", () => {
  it("commits a real usage event and its rollup without leaking a transaction", async () => {
    const { file, persistBatch } = await createFixture();
    expect(persistBatch([event()])).toBe(true);
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT count(*) AS n FROM usageHistory").get().n).toBe(1);
    expect(db.prepare("SELECT requests FROM usageRollupDay").get().requests).toBe(1);
    expect(db.prepare("SELECT lastUsedAt FROM apiKeys WHERE id='key-1'").get().lastUsedAt).toBe(event().completedAt);
    db.close();
  });

  it("waits for another process to release its write lock before the dedup read", async () => {
    const { file, persistBatch } = await createFixture();
    const holder = spawn(process.execPath, [
      "--no-warnings", new URL("../fixtures/sqlite-lock-holder.mjs", import.meta.url).pathname,
      file, "400",
    ], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise((resolve, reject) => {
        holder.stdout.once("data", resolve);
        holder.once("error", reject);
        holder.once("exit", (code) => reject(new Error(`lock holder exited early: ${code}`)));
      });
      const startedAt = Date.now();
      expect(persistBatch([event()])).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      await new Promise((resolve) => holder.once("exit", resolve));
      const db = new DatabaseSync(file);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT count(*) AS n FROM usageHistory").get().n).toBe(1);
      db.close();
    } finally {
      holder.kill();
    }
  });

  it("rolls back a failed batch so a later web write can proceed", async () => {
    const { file, persistBatch } = await createFixture();
    const db = new DatabaseSync(file);
    db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usageHistory BEGIN SELECT RAISE(ABORT, 'injected usage failure'); END;");
    db.close();
    expect(() => persistBatch([event()])).toThrow("injected usage failure");

    const web = new DatabaseSync(file);
    web.exec("PRAGMA busy_timeout=0");
    web.prepare("INSERT INTO _meta(key,value) VALUES('afterFailure','ok')").run();
    expect(web.prepare("SELECT value FROM _meta WHERE key='afterFailure'").get().value).toBe("ok");
    expect(web.prepare("SELECT count(*) AS n FROM usageHistory").get().n).toBe(0);
    web.close();
  });
});
