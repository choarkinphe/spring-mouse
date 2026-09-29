import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-stage-test-"));
process.env.DATA_DIR = tmpDir;

// Capture what would be spawned instead of running litestream.
const spawned = [];
vi.mock("node:child_process", () => ({
  spawn: (command, args, options) => {
    spawned.push({ command, args, options });
    const { EventEmitter } = require("node:events");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Emit a non-zero exit so stageRestore returns early rather than waiting on
    // a real process; the assertion is about the ARGUMENTS, not the outcome.
    setImmediate(() => child.emit("exit", 1));
    return child;
  },
}));

const { STAGING_FILE, stageRestore } = await import("../../src/lib/backup/restore.js");
const { DATA_FILE } = await import("../../src/lib/db/paths.js");

beforeEach(() => {
  spawned.length = 0;
  fs.mkdirSync(path.dirname(STAGING_FILE), { recursive: true });
});

describe("stageRestore invocation", () => {
  // A typed destination (the new shape) uses the config file. `file` needs no
  // credentials, which keeps this test focused on the argv.
  const typedSettings = {
    backupEnabled: true,
    backupDestinations: [
      { id: "dst_1", type: "file", label: "本机", config: { path: "/mnt/backup/spring-mouse" }, secretEncrypted: null },
    ],
    backupActiveDestinationId: "dst_1",
  };
  // A legacy `type:"url"` destination keeps the old positional-URL form.
  const urlSettings = {
    backupEnabled: true,
    backupDestinations: [
      { id: "dst_legacy", type: "url", label: "原有", config: { url: "file:///mnt/backup/spring-mouse" }, secretEncrypted: null },
    ],
    backupActiveDestinationId: "dst_legacy",
  };
  // The pre-migration shape, resolved through the legacy fallback.
  const legacySettings = {
    backupEnabled: true,
    backupReplicaUrl: "file:///mnt/backup/spring-mouse",
    backupAccessKeyIdEncrypted: null,
    backupAccessKeySecretEncrypted: null,
  };

  it("uses -config + the database path for a typed destination", async () => {
    await stageRestore({ settings: typedSettings });

    const restore = spawned.find((c) => c.args[0] === "restore");
    expect(restore).toBeTruthy();
    // A typed destination's extra fields (key-path, endpoint, …) live only in
    // the config file, so restore must read it — and then litestream takes the
    // DATABASE PATH positionally (never a replica URL alongside -config).
    expect(restore.args).toContain("-config");
    expect(restore.args[restore.args.length - 1]).toBe(DATA_FILE);
    expect(restore.args).not.toContain("file:///mnt/backup/spring-mouse");
    expect(restore.args[restore.args.indexOf("-o") + 1]).toBe(STAGING_FILE);
  });

  it("keeps the positional-URL form for a legacy type:\"url\" destination", async () => {
    await stageRestore({ settings: urlSettings });
    const restore = spawned.find((c) => c.args[0] === "restore");
    // litestream rejects "-config" together with a replica URL, so this pins
    // the old, tested path for installs that have not adopted a typed one.
    expect(restore.args).not.toContain("-config");
    expect(restore.args[restore.args.length - 1]).toBe("file:///mnt/backup/spring-mouse");
  });

  it("also keeps the positional-URL form for the pre-migration settings shape", async () => {
    await stageRestore({ settings: legacySettings });
    const restore = spawned.find((c) => c.args[0] === "restore");
    expect(restore.args).not.toContain("-config");
    expect(restore.args[restore.args.length - 1]).toBe("file:///mnt/backup/spring-mouse");
  });

  it("adds -timestamp only when a point-in-time restore was asked for", async () => {
    await stageRestore({ settings: typedSettings });
    expect(spawned.find((c) => c.args[0] === "restore").args).not.toContain("-timestamp");

    spawned.length = 0;
    await stageRestore({ settings: typedSettings, timestamp: "2026-09-01T00:00:00Z" });
    const args = spawned.find((c) => c.args[0] === "restore").args;
    expect(args[args.indexOf("-timestamp") + 1]).toBe("2026-09-01T00:00:00Z");
    // The database path must still come last, after the flag and its value.
    expect(args[args.length - 1]).toBe(DATA_FILE);
  });

  // Misconfiguration surfaces as a thrown error, not a soft failure: the caller
  // (the settings PATCH) turns it into a 400 with the message intact. Asserting
  // the throw keeps that contract from silently becoming "restore did nothing".
  it("throws when backup is disabled", async () => {
    await expect(stageRestore({ settings: { ...typedSettings, backupEnabled: false } }))
      .rejects.toThrow(/Backup is disabled/);
    expect(spawned).toHaveLength(0);
  });

  it("throws when there is no active destination", async () => {
    await expect(stageRestore({ settings: { backupEnabled: true, backupDestinations: [], backupActiveDestinationId: null } }))
      .rejects.toThrow(/No backup destination configured/);
    expect(spawned).toHaveLength(0);
  });
});
