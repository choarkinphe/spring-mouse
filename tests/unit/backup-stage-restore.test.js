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

beforeEach(() => {
  spawned.length = 0;
  fs.mkdirSync(path.dirname(STAGING_FILE), { recursive: true });
});

describe("stageRestore invocation", () => {
  const settings = {
    backupEnabled: true,
    backupReplicaUrl: "file:///mnt/backup/spring-mouse",
    backupAccessKeyIdEncrypted: null,
    backupAccessKeySecretEncrypted: null,
  };

  it("passes the replica URL positionally and never -config", async () => {
    await stageRestore({ settings });

    const restore = spawned.find((c) => c.args[0] === "restore");
    expect(restore).toBeTruthy();
    // litestream rejects "-config" together with a replica URL ("cannot specify
    // a replica URL and the -config flag"), so this pins the working form.
    expect(restore.args).not.toContain("-config");
    expect(restore.args[restore.args.length - 1]).toBe("file:///mnt/backup/spring-mouse");
    expect(restore.args).toContain("-o");
    expect(restore.args[restore.args.indexOf("-o") + 1]).toBe(STAGING_FILE);
  });

  it("adds -timestamp only when a point-in-time restore was asked for", async () => {
    await stageRestore({ settings });
    expect(spawned.find((c) => c.args[0] === "restore").args).not.toContain("-timestamp");

    spawned.length = 0;
    await stageRestore({ settings, timestamp: "2026-09-01T00:00:00Z" });
    const args = spawned.find((c) => c.args[0] === "restore").args;
    expect(args[args.indexOf("-timestamp") + 1]).toBe("2026-09-01T00:00:00Z");
    // The URL must still come last, after the flag and its value.
    expect(args[args.length - 1]).toBe("file:///mnt/backup/spring-mouse");
  });

  // Misconfiguration surfaces as a thrown error, not a soft failure: the caller
  // (the settings PATCH) turns it into a 400 with the message intact. Asserting
  // the throw keeps that contract from silently becoming "restore did nothing".
  it("throws when backup is disabled", async () => {
    await expect(stageRestore({ settings: { ...settings, backupEnabled: false } }))
      .rejects.toThrow(/Backup is disabled/);
    expect(spawned).toHaveLength(0);
  });

  it("throws without a URL", async () => {
    await expect(stageRestore({ settings: { ...settings, backupReplicaUrl: "" } }))
      .rejects.toThrow(/No backup URL configured/);
    expect(spawned).toHaveLength(0);
  });
});
