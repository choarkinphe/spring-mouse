import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-ls-lifecycle-test-"));
process.env.DATA_DIR = tmpDir;

// Capture spawns and let the test decide how each child behaves.
const spawned = [];
let exitOnStart = false;
// Emulates a binary that cannot be executed at all (missing from PATH, not
// executable). Node reports this as an 'error' event, never an 'exit'.
let errorOnStart = null;

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
    // A failed spawn leaves exitCode null; only 'error' fires.
    if (errorOnStart) setImmediate(() => child.emit("error", new Error(errorOnStart)));
    return child;
  },
}));

const { startLitestream, stopLitestream, getBackupStatus, BACKUP_DIR } =
  await import("../../src/lib/backup/litestream.js");

const PID_FILE = path.join(BACKUP_DIR, "litestream.pid");
const URL_A = "file:///mnt/backup-a";
const URL_B = "file:///mnt/backup-b";

// Build settings with a single legacy `type:"url"` destination — the shape an
// unmigrated install has, which needs no encrypted secret.
function settingsFor(replicaUrl) {
  return {
    backupEnabled: true,
    backupDestinations: [
      { id: "dst_test", type: "url", label: "test", config: { url: replicaUrl }, secretEncrypted: null },
    ],
    backupActiveDestinationId: "dst_test",
  };
}

// The same install, still on the pre-migration shape (legacy fallback path).
function legacySettingsFor(replicaUrl) {
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
  errorOnStart = null;
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
  it("starts a child and records the destination fingerprint in the PID file", async () => {
    const result = await startLitestream(settingsFor(URL_A));
    expect(result.started).toBe(true);
    expect(spawned).toHaveLength(1);

    const saved = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    expect(saved.pid).toBe(spawned[0].child.pid);
    // The fingerprint identifies WHICH destination the child is replicating to,
    // so a later start can tell "same destination" from "changed destination".
    expect(typeof saved.fingerprint).toBe("string");
    expect(saved.fingerprint.length).toBeGreaterThan(0);
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
    expect(saved.pid).toBe(spawned[1].child.pid);
  });

  it("replaces the child when the ACTIVE destination is switched", async () => {
    const twoDestinations = {
      backupEnabled: true,
      backupDestinations: [
        { id: "dst_a", type: "url", label: "a", config: { url: URL_A }, secretEncrypted: null },
        { id: "dst_b", type: "url", label: "b", config: { url: URL_B }, secretEncrypted: null },
      ],
      backupActiveDestinationId: "dst_a",
    };
    await startLitestream(twoDestinations);
    expect(spawned).toHaveLength(1);

    // Activate the other destination: same list, different active id.
    const switched = await startLitestream({ ...twoDestinations, backupActiveDestinationId: "dst_b" });
    expect(switched.started).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].child.killed).toBe(true);
  });

  it("replaces the child when the active destination's config is edited", async () => {
    const dest = {
      backupEnabled: true,
      backupDestinations: [
        { id: "dst_a", type: "file", label: "a", config: { path: "/mnt/backup-one" }, secretEncrypted: null },
      ],
      backupActiveDestinationId: "dst_a",
    };
    await startLitestream(dest);
    expect(spawned).toHaveLength(1);

    // Same id, changed path — the fingerprint must change, so the old child
    // (writing to the wrong place) is replaced rather than adopted.
    const edited = {
      ...dest,
      backupDestinations: [{ ...dest.backupDestinations[0], config: { path: "/mnt/backup-two" } }],
    };
    const result = await startLitestream(edited);
    expect(result.started).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].child.killed).toBe(true);
  });

  it("resolves a pre-migration install through the legacy fallback", async () => {
    const result = await startLitestream(legacySettingsFor(URL_A));
    expect(result.started).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it("reports a failure when the child exits immediately", async () => {
    exitOnStart = true;
    await expect(startLitestream(settingsFor(URL_A))).rejects.toThrow(/failed to start|exited/);
    const status = await getBackupStatus(settingsFor(URL_A));
    expect(status.running).toBe(false);
    expect(status.lastError).toBeTruthy();
  });

  it("rejects (does not crash the process) when the binary cannot be spawned", async () => {
    // A missing/non-executable binary emits 'error', not 'exit'. Unhandled, that
    // becomes an uncaughtException that takes the server down — and since
    // LITESTREAM_BIN defaults to a bare "litestream" on PATH, any host without
    // it would crash on the first enable. It must surface as a normal rejection.
    errorOnStart = "spawn litestream ENOENT";
    await expect(startLitestream(settingsFor(URL_A))).rejects.toThrow(/cannot run litestream/);

    const status = await getBackupStatus(settingsFor(URL_A));
    expect(status.running).toBe(false);
    // A child that never ran must not be recorded as a live replicator, or the
    // next start would try to adopt a PID that means nothing.
    expect(fs.existsSync(PID_FILE)).toBe(false);
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

  it("reports a secret-free display URL and per-type credential state", async () => {
    await startLitestream(settingsFor(URL_A));
    const status = await getBackupStatus(settingsFor(URL_A));
    expect(status.replicaUrl).toBe("file:///mnt/backup-a");
    expect(status.destinationCount).toBe(1);
    expect(status.activeDestinationId).toBe("dst_test");
  });

  it("treats a typed file destination as needing no credentials", async () => {
    const settings = {
      backupEnabled: true,
      backupDestinations: [
        { id: "dst_f", type: "file", label: "本机", config: { path: "/mnt/x" }, secretEncrypted: null },
      ],
      backupActiveDestinationId: "dst_f",
    };
    const status = await getBackupStatus(settings);
    // file needs no secret, so it is always "configured" — unlike a `url`
    // destination, whose credential needs are unknown.
    expect(status.hasCredentials).toBe(true);
  });
});
