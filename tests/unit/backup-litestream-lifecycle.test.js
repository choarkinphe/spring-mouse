import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-ls-lifecycle-test-"));
process.env.DATA_DIR = tmpDir;

// Capture spawns and let the test decide how each child behaves.
const spawned = [];
let exitOnStart = false;

vi.mock("node:child_process", () => ({
  spawn: (command, args, options) => {
    const { EventEmitter } = require("node:events");
    const child = new EventEmitter();
    child.pid = 900000 + spawned.length;
    child.exitCode = null;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => { child.killed = true; child.exitCode = 0; child.emit("exit", 0, sig); return true; };
    spawned.push({ command, args, options, child });
    if (exitOnStart) setImmediate(() => { child.exitCode = 1; child.emit("exit", 1, null); });
    return child;
  },
}));

const { startLitestream, stopLitestream, getBackupStatus, BACKUP_DIR } =
  await import("../../src/lib/backup/litestream.js");

const PID_FILE = path.join(BACKUP_DIR, "litestream.pid");
const URL_A = "file:///mnt/backup-a";
const URL_B = "file:///mnt/backup-b";

function settingsFor(replicaUrl) {
  return {
    backupEnabled: true,
    backupReplicaUrl: replicaUrl,
    backupAccessKeyIdEncrypted: null,
    backupAccessKeySecretEncrypted: null,
  };
}

beforeEach(() => {
  spawned.length = 0;
  exitOnStart = false;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  // Clear any child left over from a previous test in this file.
  stopLitestream();
  spawned.length = 0;
});

afterEach(() => {
  stopLitestream();
});

describe("litestream lifecycle", () => {
  it("starts a child and records the destination in the PID file", async () => {
    const result = await startLitestream(settingsFor(URL_A));
    expect(result.started).toBe(true);
    expect(spawned).toHaveLength(1);

    const saved = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    expect(saved.pid).toBe(spawned[0].child.pid);
    // The URL is stored so a later start can tell whether the running process
    // still points where the settings say.
    expect(saved.replicaUrl).toBe(URL_A);
  });

  it("does not spawn a second child for the same destination", async () => {
    await startLitestream(settingsFor(URL_A));
    const second = await startLitestream(settingsFor(URL_A));
    expect(second.started).toBe(false);
    expect(second.reason).toMatch(/already running/);
    expect(spawned).toHaveLength(1);
  });

  it("replaces the child when the destination changes", async () => {
    await startLitestream(settingsFor(URL_A));
    const firstPid = spawned[0].child.pid;

    const second = await startLitestream(settingsFor(URL_B));
    expect(second.started).toBe(true);
    // Two children spawned, and the first was signalled.
    expect(spawned).toHaveLength(2);
    expect(spawned[0].child.killed).toBe(true);
    expect(second.pid).not.toBe(firstPid);

    const saved = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    expect(saved.replicaUrl).toBe(URL_B);
  });

  it("reports a failure when the child exits immediately", async () => {
    exitOnStart = true;
    await expect(startLitestream(settingsFor(URL_A))).rejects.toThrow(/failed to start|exited/);
    const status = await getBackupStatus(settingsFor(URL_A));
    expect(status.running).toBe(false);
    expect(status.lastError).toBeTruthy();
  });

  it("refuses to start when backup is disabled", async () => {
    await expect(startLitestream({ ...settingsFor(URL_A), backupEnabled: false }))
      .rejects.toThrow(/Backup is disabled/);
    expect(spawned).toHaveLength(0);
  });

  it("clears the recorded state on stop", async () => {
    await startLitestream(settingsFor(URL_A));
    stopLitestream();
    expect(fs.existsSync(PID_FILE)).toBe(false);
    const status = await getBackupStatus(settingsFor(URL_A));
    expect(status.running).toBe(false);
  });
});
