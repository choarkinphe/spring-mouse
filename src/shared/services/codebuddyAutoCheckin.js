import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { runCodeBuddyCheckin } from "@/lib/services/codebuddyCheckin.js";

const INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const state = globalThis.__codebuddyAutoCheckin ??= { timer: null, initialTimer: null, running: false };

export async function runCodeBuddyCheckinTick({ loadConnections = getProviderConnections, checkin = runCodeBuddyCheckin } = {}) {
  if (state.running) return { skipped: "running" };
  state.running = true;
  let attempted = 0;
  let failed = 0;
  try {
    const connections = await loadConnections({ provider: "codebuddy-cn", isActive: true });
    for (const connection of connections) {
      if (connection.provider !== "codebuddy-cn" || connection.authType !== "oauth" || connection.isActive === false) continue;
      try {
        const result = await checkin(connection.id, { automatic: true });
        if (!result.skipped) attempted++;
        if (!result.ok && !result.skipped) failed++;
      } catch {
        failed++;
      }
    }
    return { attempted, failed };
  } catch {
    console.warn("[CodeBuddyCheckin] scheduler tick failed");
    return { attempted, failed, error: "tick_failed" };
  } finally {
    state.running = false;
  }
}

export function startCodeBuddyAutoCheckin() {
  if (state.timer || typeof window !== "undefined" || process.env.NEXT_RUNTIME === "edge"
    || ["phase-production-build", "phase-export", "phase-static"].includes(process.env.NEXT_PHASE)) return false;
  const tick = () => { void runCodeBuddyCheckinTick(); };
  state.initialTimer = setTimeout(() => { state.initialTimer = null; tick(); }, INITIAL_DELAY_MS);
  state.initialTimer.unref?.();
  state.timer = setInterval(tick, INTERVAL_MS);
  state.timer.unref?.();
  return true;
}

export function stopCodeBuddyAutoCheckin() {
  clearTimeout(state.initialTimer);
  clearInterval(state.timer);
  state.initialTimer = null;
  state.timer = null;
}
