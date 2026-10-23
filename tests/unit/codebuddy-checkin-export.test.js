import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real export/import transaction against an isolated SQLite DB.
vi.mock("@/lib/redis/hotCache.js", () => ({
  getHotJson: vi.fn(async () => null),
  setHotJson: vi.fn(async () => true),
  fillHotJson: vi.fn(async () => true),
  deleteHotJson: vi.fn(async () => true),
  incrementHotCounter: vi.fn(async () => 1),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let exportDb;
let importDb;
let fetchMock;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-checkin-export-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  fetchMock = vi.fn(() => { throw new Error("Unexpected network request"); });
  vi.stubGlobal("fetch", fetchMock);
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  ({ exportDb, importDb } = await import("@/lib/db/index.js"));
});

beforeEach(() => {
  db.run("DELETE FROM kv");
  fetchMock.mockClear();
});

afterAll(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  db?.close?.();
  delete global._dbAdapter;
  vi.unstubAllGlobals();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function put(key, state) {
  db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('codebuddyCheckin', ?, ?)", [key, JSON.stringify(state)]);
}

function read(key) {
  const row = db.get("SELECT value FROM kv WHERE scope = 'codebuddyCheckin' AND key = ?", [key]);
  return row ? JSON.parse(row.value) : undefined;
}

const permanent = {
  enabled: true,
  status: "success",
  message: "签到成功",
  lastAttemptAt: "2026-10-22T04:00:00.000Z",
  lastSuccessDate: "2026-10-22",
  reward: 25,
  terminalDate: null,
  retryAfter: 0,
  futureField: { keep: true },
};

describe("CodeBuddy check-in backup state", () => {
  it("exports raw KV keys and all permanent fields without leaking or clearing live leases", async () => {
    const live = { ...permanent, leaseId: "live-owner", leaseUntil: 123456 };
    put("connection-a", live);
    put("account:codebuddy-cn:uid-123", { enabled: false, lastSuccessDate: "2026-10-21" });
    put("__proto__", { enabled: false });

    const backup = JSON.parse(JSON.stringify(await exportDb()));
    expect(backup.codebuddyCheckin).toEqual(JSON.parse('{"connection-a":' + JSON.stringify(permanent)
      + ',"account:codebuddy-cn:uid-123":{"enabled":false,"lastSuccessDate":"2026-10-21"},"__proto__":{"enabled":false}}'));
    expect(read("connection-a")).toEqual(live);
  });

  it("imports permanent state, strips injected leases, and removes preexisting keys", async () => {
    put("stale-target", { enabled: true, leaseId: "old-owner", leaseUntil: 999999 });
    const incoming = { ...permanent, leaseId: "backup-owner", leaseUntil: 999999 };
    const payload = { codebuddyCheckin: { "connection-a": incoming } };

    const restored = await importDb(payload);
    expect(read("stale-target")).toBeUndefined();
    expect(read("connection-a")).toEqual(permanent);
    expect(restored.codebuddyCheckin).toEqual({ "connection-a": permanent });
    expect(incoming.leaseId).toBe("backup-owner");
    expect(incoming.leaseUntil).toBe(999999);
  });

  it("clears check-in state when restoring an older backup without the scope", async () => {
    put("connection-a", permanent);
    const restored = await importDb({});
    expect(read("connection-a")).toBeUndefined();
    expect(restored.codebuddyCheckin).toEqual({});
  });

  it("round-trips opt-in flags and daily markers without temporary leases", async () => {
    put("connection-a", { ...permanent, leaseId: "running", leaseUntil: 123456 });
    put("connection-b", { enabled: false, status: "own_app", terminalDate: "2026-10-22", retryAfter: 1234 });
    const backup = JSON.parse(JSON.stringify(await exportDb()));
    db.run("DELETE FROM kv WHERE scope = 'codebuddyCheckin'");
    const restored = await importDb(backup);
    expect(restored.codebuddyCheckin).toEqual(backup.codebuddyCheckin);
    expect(read("connection-a")).toEqual(permanent);
    expect(read("connection-b")).toEqual(backup.codebuddyCheckin["connection-b"]);
  });

  it("fails closed and rolls back invalid imported state instead of resetting markers", async () => {
    put("existing", permanent);
    await expect(importDb({ codebuddyCheckin: { broken: null } })).rejects.toThrow("Invalid check-in state");
    expect(read("existing")).toEqual(permanent);
  });
});
