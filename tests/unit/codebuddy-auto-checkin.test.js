import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), checkin: vi.fn() }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnections: mocks.load }));
vi.mock("@/lib/services/codebuddyCheckin.js", () => ({ runCodeBuddyCheckin: mocks.checkin }));

let scheduler;
const eligible = (id, extra = {}) => ({ id, provider: "codebuddy-cn", authType: "oauth", isActive: true, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "phase-development-server");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected upstream request"); }));
  delete globalThis.__codebuddyAutoCheckin;
  mocks.load.mockResolvedValue([]);
  mocks.checkin.mockResolvedValue({ ok: true, status: "success" });
  scheduler = await import("@/shared/services/codebuddyAutoCheckin.js");
});

afterEach(() => {
  scheduler.stopCodeBuddyAutoCheckin();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete globalThis.__codebuddyAutoCheckin;
});

describe("CodeBuddy automatic check-in tick", () => {
  it("loads active accounts once and checks both China providers only", async () => {
    const loadConnections = vi.fn().mockResolvedValue([
      eligible("cn"), eligible("workbuddy", { provider: "workbuddy" }),
      eligible("intl", { provider: "codebuddy-intl" }), eligible("ai", { provider: "workbuddy-ai" }),
      eligible("legacy-intl", { provider: "codebuddy" }),
      eligible("apikey", { authType: "apikey" }), eligible("disabled", { isActive: false }),
      eligible("no-active-field", { isActive: undefined }),
    ]);
    const checkin = vi.fn().mockResolvedValue({ ok: true });
    expect(await scheduler.runCodeBuddyCheckinTick({ loadConnections, checkin })).toEqual({ attempted: 3, failed: 0 });
    expect(loadConnections).toHaveBeenCalledWith({ isActive: true });
    expect(checkin.mock.calls).toEqual([
      ["cn", { automatic: true }], ["workbuddy", { automatic: true }], ["no-active-field", { automatic: true }],
    ]);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.checkin).not.toHaveBeenCalled();
  });

  it("runs both providers when enabled and still skips opted-out accounts", async () => {
    // `enabled` is per connection and enforced by the service (skipped:"disabled").
    const loadConnections = vi.fn().mockResolvedValue([
      eligible("cn-on"), eligible("wb-on", { provider: "workbuddy" }),
      eligible("wb-off", { provider: "workbuddy" }), eligible("cn-off"),
    ]);
    const checkin = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: "success" })
      .mockResolvedValueOnce({ ok: true, status: "success" })
      .mockResolvedValueOnce({ ok: false, skipped: "disabled" })
      .mockResolvedValueOnce({ ok: false, skipped: "disabled" });
    expect(await scheduler.runCodeBuddyCheckinTick({ loadConnections, checkin })).toEqual({ attempted: 2, failed: 0 });
    expect(checkin.mock.calls.map(([id]) => id)).toEqual(["cn-on", "wb-on", "wb-off", "cn-off"]);
  });

  it("isolates rejected accounts and failed results, continuing through later accounts", async () => {
    const loadConnections = vi.fn().mockResolvedValue(["throws", "failed", "skipped", "success", "today"].map((id) => eligible(id)));
    const checkin = vi.fn()
      .mockRejectedValueOnce(new Error("private upstream failure"))
      .mockResolvedValueOnce({ ok: false, status: "error" })
      .mockResolvedValueOnce({ ok: false, skipped: "disabled" })
      .mockResolvedValueOnce({ ok: true, status: "success" })
      .mockResolvedValueOnce({ ok: true, skipped: "today" });
    expect(await scheduler.runCodeBuddyCheckinTick({ loadConnections, checkin })).toEqual({ attempted: 2, failed: 2 });
    expect(checkin.mock.calls.map(([id]) => id)).toEqual(["throws", "failed", "skipped", "success", "today"]);
    expect(globalThis.__codebuddyAutoCheckin.running).toBe(false);
  });

  it("prevents concurrent ticks, including across HMR module re-evaluation", async () => {
    const pending = deferred();
    const loadConnections = vi.fn(() => pending.promise);
    const checkin = vi.fn().mockResolvedValue({ ok: true });
    const first = scheduler.runCodeBuddyCheckinTick({ loadConnections, checkin });
    expect(await scheduler.runCodeBuddyCheckinTick({ loadConnections, checkin })).toEqual({ skipped: "running" });
    vi.resetModules();
    const reloaded = await import("@/shared/services/codebuddyAutoCheckin.js");
    expect(await reloaded.runCodeBuddyCheckinTick({ loadConnections, checkin })).toEqual({ skipped: "running" });
    expect(loadConnections).toHaveBeenCalledTimes(1);
    pending.resolve([eligible("first")]);
    expect(await first).toEqual({ attempted: 1, failed: 0 });
    expect(globalThis.__codebuddyAutoCheckin.running).toBe(false);
  });

  it("sanitizes list failures and clears running so the next tick can recover", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.load.mockRejectedValueOnce(new Error("access-token-secret proxy-password"));
    expect(await scheduler.runCodeBuddyCheckinTick()).toEqual({ attempted: 0, failed: 0, error: "tick_failed" });
    expect(warn).toHaveBeenCalledWith("[CodeBuddyCheckin] scheduler tick failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("access-token-secret");
    expect(globalThis.__codebuddyAutoCheckin.running).toBe(false);
    expect(await scheduler.runCodeBuddyCheckinTick()).toEqual({ attempted: 0, failed: 0 });
  });
});

describe("scheduler lifecycle and HMR", () => {
  it("does not start just by importing the module", () => {
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("runs the initial tick after 30 seconds and subsequent ticks every 15 minutes", async () => {
    mocks.load.mockResolvedValue([eligible("scheduled")]);
    expect(scheduler.startCodeBuddyAutoCheckin()).toBe(true);
    expect(vi.getTimerCount()).toBe(2);
    const state = globalThis.__codebuddyAutoCheckin;
    expect(state.initialTimer.hasRef?.()).toBe(false);
    expect(state.timer.hasRef?.()).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.checkin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.checkin).toHaveBeenCalledExactlyOnceWith("scheduled", { automatic: true });
    expect(state.initialTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 30 * 1000);
    expect(mocks.checkin).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(mocks.checkin).toHaveBeenCalledTimes(3);
  });

  it("keeps one timer pair across repeat starts and HMR; either module can stop and restart it", async () => {
    expect(scheduler.startCodeBuddyAutoCheckin()).toBe(true);
    const initialState = globalThis.__codebuddyAutoCheckin;
    expect(scheduler.startCodeBuddyAutoCheckin()).toBe(false);
    vi.resetModules();
    const reloaded = await import("@/shared/services/codebuddyAutoCheckin.js");
    expect(globalThis.__codebuddyAutoCheckin).toBe(initialState);
    expect(reloaded.startCodeBuddyAutoCheckin()).toBe(false);
    expect(vi.getTimerCount()).toBe(2);
    reloaded.stopCodeBuddyAutoCheckin();
    expect(vi.getTimerCount()).toBe(0);
    expect(initialState).toMatchObject({ timer: null, initialTimer: null });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.load).not.toHaveBeenCalled();
    scheduler.stopCodeBuddyAutoCheckin();
    expect(reloaded.startCodeBuddyAutoCheckin()).toBe(true);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("stop after the initial tick cancels the remaining interval", async () => {
    scheduler.startCodeBuddyAutoCheckin();
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.stopCodeBuddyAutoCheckin();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it.each(["phase-production-build", "phase-export", "phase-static"])("does not start during %s", (phase) => {
    vi.stubEnv("NEXT_PHASE", phase);
    expect(scheduler.startCodeBuddyAutoCheckin()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start on the edge runtime", () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    expect(scheduler.startCodeBuddyAutoCheckin()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start in a browser", () => {
    vi.stubGlobal("window", {});
    expect(scheduler.startCodeBuddyAutoCheckin()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
