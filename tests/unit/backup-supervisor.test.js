import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The supervisor imports the settings repo (which resolves DATA_DIR at import
// time), so point it at a throwaway directory first.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-supervisor-test-"));

const { createBackupSupervisor, INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, HEALTH_CHECK_DELAY_MS } =
  await import("../../src/lib/backup/supervisor.js");

// A fake scheduler so the test drives time by hand instead of waiting on real
// timers. Each scheduled callback is captured with its delay.
function createFakeSchedule() {
  const calls = [];
  const schedule = (fn, delayMs) => {
    const entry = { fn, delayMs, cancelled: false };
    calls.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  };
  return {
    calls,
    schedule,
    // Run the most recently scheduled (uncancelled) callback, like a timer
    // firing. The callback kicks off an async check without returning its
    // promise, so drain the microtask queue before handing control back.
    async fireLast() {
      const entry = [...calls].reverse().find((c) => !c.cancelled);
      if (!entry) throw new Error("nothing scheduled");
      entry.fn();
      await new Promise((resolve) => setImmediate(resolve));
      return entry;
    },
    lastDelay: () => calls[calls.length - 1]?.delayMs,
  };
}

function createDeps(overrides = {}) {
  const clock = createFakeSchedule();
  return {
    clock,
    deps: {
      loadSettings: async () => ({ backupEnabled: true }),
      start: vi.fn(async () => ({ started: true })),
      stop: vi.fn(() => ({ stopped: true })),
      status: vi.fn(async () => ({ running: false })),
      schedule: clock.schedule,
      log: { warn: () => {} },
      ...overrides,
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("backup supervisor", () => {
  it("starts replication when enabled and not already running", async () => {
    const { deps, clock } = createDeps();
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();

    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(clock.lastDelay()).toBe(HEALTH_CHECK_DELAY_MS);
  });

  it("does not start a second replicator when one is already running", async () => {
    const { deps } = createDeps({ status: async () => ({ running: true }) });
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();

    expect(deps.start).not.toHaveBeenCalled();
  });

  it("stops a stray replicator when the setting has been turned off", async () => {
    const { deps } = createDeps({
      loadSettings: async () => ({ backupEnabled: false }),
      status: async () => ({ running: true }),
    });
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();

    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("backs off exponentially when start fails, and keeps retrying", async () => {
    const { deps, clock } = createDeps({ start: vi.fn(async () => { throw new Error("no credentials"); }) });
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();
    expect(clock.lastDelay()).toBe(INITIAL_RETRY_DELAY_MS * 2);

    await clock.fireLast();
    expect(clock.lastDelay()).toBe(INITIAL_RETRY_DELAY_MS * 4);

    await clock.fireLast();
    expect(clock.lastDelay()).toBe(INITIAL_RETRY_DELAY_MS * 8);
  });

  it("caps the backoff so a long outage does not delay recovery forever", async () => {
    const { deps, clock } = createDeps({ start: vi.fn(async () => { throw new Error("down"); }) });
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();
    for (let i = 0; i < 12; i++) await clock.fireLast();

    expect(clock.lastDelay()).toBe(MAX_RETRY_DELAY_MS);
  });

  it("resets the backoff after a successful start", async () => {
    const start = vi.fn(async () => { throw new Error("down"); });
    const { deps, clock } = createDeps({ start });
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();
    await clock.fireLast();
    expect(clock.lastDelay()).toBe(INITIAL_RETRY_DELAY_MS * 4);

    start.mockImplementation(async () => ({ started: true }));
    await clock.fireLast();
    expect(clock.lastDelay()).toBe(HEALTH_CHECK_DELAY_MS);
  });

  it("survives a loadSettings throw instead of dying silently", async () => {
    let calls = 0;
    const { deps, clock } = createDeps({
      loadSettings: async () => { calls += 1; if (calls === 1) throw new Error("db closed"); return { backupEnabled: true }; },
    });
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();

    // Still scheduled, and the next check actually runs.
    expect(clock.lastDelay()).toBe(HEALTH_CHECK_DELAY_MS);
    await clock.fireLast();
    expect(deps.start).toHaveBeenCalledTimes(1);
  });

  it("stops scheduling once stopped", async () => {
    const { deps, clock } = createDeps();
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    await tick();
    const before = clock.calls.length;
    supervisor.stop();
    await tick();

    expect(deps.stop).toHaveBeenCalled();
    // No new check was scheduled after stop().
    expect(clock.calls.length).toBe(before);
  });

  it("does not double-run when start() is called twice", async () => {
    const { deps } = createDeps();
    const supervisor = createBackupSupervisor(deps);

    supervisor.start();
    supervisor.start();
    await tick();

    expect(deps.start).toHaveBeenCalledTimes(1);
  });
});
