// Keeps the backup replicator running to match the persisted settings.
//
// MODELED ON src/shared/services/cloudflareTunnelSupervisor.js: a process-global
// timer with `.unref()` (never keeps the process alive on its own), re-entrancy
// guarded by a single in-flight promise, and exponential backoff so a
// misconfigured destination does not spawn a child every few hundred
// milliseconds.
//
// WHY A SUPERVISOR AND NOT JUST start/stop: litestream can exit after a
// successful start — credentials revoked, bucket deleted, network gone. Without
// a periodic check the backup silently stops and the operator keeps believing
// it is running, which is precisely the failure this feature exists to prevent.
// The check interval is short for that reason; a missing backup is only useful
// to know about while it can still be fixed.

import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { startLitestream, stopLitestream, getBackupStatus } from "@/lib/backup/litestream.js";

export const INITIAL_RETRY_DELAY_MS = 5_000;
export const MAX_RETRY_DELAY_MS = 60_000;
export const HEALTH_CHECK_DELAY_MS = 30_000;

function scheduleUnref(fn, delayMs) {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return timer;
}

export function createBackupSupervisor({
  loadSettings = getSettings,
  start = startLitestream,
  stop = stopLitestream,
  status = getBackupStatus,
  schedule = scheduleUnref,
  log = console,
} = {}) {
  let timer = null;
  let active = false;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;
  let checkPromise = null;

  const scheduleNext = (delayMs) => {
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = schedule(() => {
      timer = null;
      void check();
    }, delayMs);
  };

  const check = () => {
    if (!active || checkPromise) return checkPromise;

    checkPromise = (async () => {
      try {
        const settings = await loadSettings();
        if (settings?.backupEnabled !== true) {
          // Disabled: make sure nothing is left running, then idle. Checking
          // rather than assuming, because the setting may have been flipped in
          // another process (the Redis-shared settings cache means this one
          // would not know).
          const current = await status(settings);
          if (current.running) stop();
          retryDelayMs = INITIAL_RETRY_DELAY_MS;
          scheduleNext(HEALTH_CHECK_DELAY_MS);
          return;
        }

        const current = await status(settings);
        if (current.running) {
          retryDelayMs = INITIAL_RETRY_DELAY_MS;
          scheduleNext(HEALTH_CHECK_DELAY_MS);
          return;
        }

        try {
          await start(settings);
          retryDelayMs = INITIAL_RETRY_DELAY_MS;
          scheduleNext(HEALTH_CHECK_DELAY_MS);
        } catch (error) {
          log.warn?.(`[Backup] start failed: ${error.message}`);
          retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
          scheduleNext(retryDelayMs);
        }
      } catch (error) {
        // Never let the supervisor die: a throw here would stop all future
        // checks and the backup would stay down unnoticed.
        log.warn?.(`[Backup] supervisor check failed: ${error.message}`);
        scheduleNext(HEALTH_CHECK_DELAY_MS);
      } finally {
        checkPromise = null;
      }
    })();

    return checkPromise;
  };

  return {
    start() {
      if (active) return;
      active = true;
      void check();
    },
    stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
      stop();
    },
    check,
  };
}

if (!globalThis.__springMouseBackupSupervisor) {
  globalThis.__springMouseBackupSupervisor = createBackupSupervisor();
}
const supervisor = globalThis.__springMouseBackupSupervisor;

export function startBackupSupervisor() {
  supervisor.start();
}

export function stopBackupSupervisor() {
  supervisor.stop();
}

// Apply a settings change right now instead of waiting for the next tick.
// Called from the settings PATCH so the response can report a real failure.
export async function applyBackupSettings(settings = null) {
  const s = settings || (await getSettings());
  if (s.backupEnabled !== true) {
    stopLitestream();
    return { running: false };
  }
  const result = await startLitestream(s);
  return { running: true, ...result };
}
