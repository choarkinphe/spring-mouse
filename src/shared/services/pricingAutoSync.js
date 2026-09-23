/**
 * Periodic pricing refresh from the shared models.dev catalog.
 *
 * Opt-in (settings.pricingAutoSyncEnabled, default false) because it writes
 * pricing rows. Mirrors apiKeyQuotaResetScheduler: a process-global timer that
 * survives Next's hot reload, and `.unref()` so it never keeps the process
 * alive on its own.
 *
 * The first tick is deferred rather than run at startup — `initializeApp`
 * already does heavy work on a delay, and there is no reason to race it.
 */

import { getSettings, updateSettings } from "@/lib/localDb";
import { syncModelPricing } from "@/shared/services/pricingSyncService";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1h floor; a shorter period has no value
// Startup delay: let the app settle before the first network call.
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

function resolveIntervalMs() {
  const configured = Number(process.env.SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, configured);
}

const state = global.__pricingAutoSync ??= {
  timer: null,
  firstRunTimer: null,
  running: false,
  enabled: false,
  lastRunAt: null,
  lastResult: null,
};

export async function runPricingSyncTick({ force = false } = {}) {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  try {
    const settings = await getSettings();
    if (!force && settings?.pricingAutoSyncEnabled !== true) {
      return { skipped: "disabled" };
    }

    const result = await syncModelPricing({ forceCatalogRefresh: false });
    const finishedAt = new Date().toISOString();
    state.lastRunAt = finishedAt;
    state.lastResult = result;

    if (result.ok) {
      // Persisted so the settings page can show the last run without the timer
      // state, which is per-process.
      await updateSettings({ pricingAutoSyncLastRunAt: finishedAt }).catch(() => {});
      if (result.total > 0) {
        console.log(`[PricingAutoSync] added ${result.added}, corrected ${result.fixed}`);
      }
    } else {
      console.warn("[PricingAutoSync] sync failed:", result.error);
    }
    return result;
  } catch (error) {
    console.warn("[PricingAutoSync] tick failed:", error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  } finally {
    state.running = false;
  }
}

function clearTimers() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.firstRunTimer) { clearTimeout(state.firstRunTimer); state.firstRunTimer = null; }
}

/**
 * Start, stop, or restart the schedule to match the current setting.
 * Safe to call repeatedly (the settings PATCH handler calls it on every change).
 */
export function configurePricingAutoSync(settings) {
  const enabled = settings?.pricingAutoSyncEnabled === true;
  const wasEnabled = state.enabled;
  state.enabled = enabled;

  if (!enabled) {
    clearTimers();
    return { enabled: false };
  }

  // Already running on the same setting — keep the existing schedule.
  if (wasEnabled && state.timer) return { enabled: true, intervalMs: resolveIntervalMs() };

  clearTimers();
  const intervalMs = resolveIntervalMs();
  state.firstRunTimer = setTimeout(() => {
    state.firstRunTimer = null;
    void runPricingSyncTick();
  }, FIRST_RUN_DELAY_MS);
  state.firstRunTimer.unref?.();

  state.timer = setInterval(() => { void runPricingSyncTick(); }, intervalMs);
  state.timer.unref?.();
  return { enabled: true, intervalMs };
}

/** Idempotent startup entry, matching the other schedulers. */
export function startPricingAutoSync(settings) {
  return configurePricingAutoSync(settings);
}

export function getPricingAutoSyncStatus() {
  return {
    enabled: state.enabled,
    running: state.running,
    intervalMs: resolveIntervalMs(),
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
  };
}
