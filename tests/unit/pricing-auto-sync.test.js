import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduler writes pricing rows, so these tests focus on when it must NOT
 * run: disabled, already running, or a failing catalog fetch.
 */

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/shared/services/pricingSyncService", () => ({
  syncModelPricing: vi.fn(),
}));

async function loadModules({ settings, syncResult } = {}) {
  vi.resetModules();
  const localDb = await import("@/lib/localDb");
  const svc = await import("@/shared/services/pricingSyncService");
  localDb.getSettings.mockResolvedValue(settings ?? {});
  localDb.updateSettings.mockResolvedValue(undefined);
  svc.syncModelPricing.mockResolvedValue(
    syncResult ?? { ok: true, total: 0, added: 0, fixed: 0, stats: null, unresolved: [] },
  );
  const mod = await import("../../src/shared/services/pricingAutoSync.js");
  return { mod, localDb, svc };
}

beforeEach(() => {
  // The scheduler keeps its state on globalThis to survive hot reload; clear it
  // so each test starts from a known state.
  delete global.__pricingAutoSync;
  // vi.resetModules() re-imports the module graph but the vi.fn() instances
  // themselves persist, so their call history must be cleared explicitly —
  // otherwise assertions like "not.toHaveBeenCalled()" see earlier tests' calls.
  vi.clearAllMocks();
});

describe("pricingAutoSync", () => {
  it("does nothing when the setting is off", async () => {
    const { mod, svc } = await loadModules({ settings: { pricingAutoSyncEnabled: false } });

    const result = await mod.runPricingSyncTick();

    expect(result).toEqual({ skipped: "disabled" });
    expect(svc.syncModelPricing).not.toHaveBeenCalled();
  });

  it("syncs when the setting is on", async () => {
    const { mod, svc, localDb } = await loadModules({
      settings: { pricingAutoSyncEnabled: true },
      syncResult: { ok: true, total: 3, added: 2, fixed: 1, stats: {}, unresolved: [] },
    });

    const result = await mod.runPricingSyncTick();

    expect(result.ok).toBe(true);
    expect(svc.syncModelPricing).toHaveBeenCalledTimes(1);
    // The interval tick must NOT force a catalog refresh — only the manual
    // action does, or a short interval would hammer models.dev.
    expect(svc.syncModelPricing).toHaveBeenCalledWith({ forceCatalogRefresh: false });
    expect(localDb.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ pricingAutoSyncLastRunAt: expect.any(String) }),
    );
  });

  it("does not overlap runs", async () => {
    const { mod, svc } = await loadModules({ settings: { pricingAutoSyncEnabled: true } });

    // Make the sync hang so the second tick lands while the first is in flight.
    let release;
    svc.syncModelPricing.mockImplementation(() => new Promise((r) => { release = r; }));

    const first = mod.runPricingSyncTick();
    const second = await mod.runPricingSyncTick();

    expect(second).toEqual({ skipped: "already running" });
    release({ ok: true, total: 0, added: 0, fixed: 0, stats: null, unresolved: [] });
    await first;
  });

  it("records a failure without throwing", async () => {
    const { mod, localDb } = await loadModules({
      settings: { pricingAutoSyncEnabled: true },
      syncResult: { ok: false, error: "catalog unreachable" },
    });

    const result = await mod.runPricingSyncTick();

    expect(result.ok).toBe(false);
    // A failed run must not stamp a "last run" time — that would make the UI
    // claim a successful sync that never happened.
    expect(localDb.updateSettings).not.toHaveBeenCalled();
  });

  it("survives a thrown error from the service", async () => {
    const { mod, svc } = await loadModules({ settings: { pricingAutoSyncEnabled: true } });
    svc.syncModelPricing.mockRejectedValue(new Error("boom"));

    const result = await mod.runPricingSyncTick();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("clears its timers when disabled", async () => {
    const { mod } = await loadModules({ settings: { pricingAutoSyncEnabled: true } });

    const on = mod.configurePricingAutoSync({ pricingAutoSyncEnabled: true });
    expect(on.enabled).toBe(true);
    expect(global.__pricingAutoSync.timer).toBeTruthy();

    const off = mod.configurePricingAutoSync({ pricingAutoSyncEnabled: false });
    expect(off.enabled).toBe(false);
    expect(global.__pricingAutoSync.timer).toBeNull();
    expect(global.__pricingAutoSync.firstRunTimer).toBeNull();
  });

  it("honours the interval env override with a one-hour floor", async () => {
    const { mod } = await loadModules();
    const original = process.env.SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS;
    try {
      // Below the floor is clamped up: a sub-hour refresh has no value and would
      // just re-scan the catalog.
      process.env.SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS = "1000";
      expect(mod.getPricingAutoSyncStatus().intervalMs).toBe(60 * 60 * 1000);

      process.env.SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS = String(6 * 60 * 60 * 1000);
      expect(mod.getPricingAutoSyncStatus().intervalMs).toBe(6 * 60 * 60 * 1000);

      delete process.env.SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS;
      expect(mod.getPricingAutoSyncStatus().intervalMs).toBe(24 * 60 * 60 * 1000);
    } finally {
      if (original === undefined) delete process.env.SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS;
      else process.env.SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS = original;
    }
  });
});
