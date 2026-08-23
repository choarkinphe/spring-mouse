import { advanceApiKeyQuotaResets } from "@/lib/apiKeyQuota";

const INTERVAL_MS = 60_000;
const state = global.__apiKeyQuotaResetScheduler ??= { timer: null, running: false };

export async function runApiKeyQuotaResetTick() {
  if (state.running) return;
  state.running = true;
  try { await advanceApiKeyQuotaResets(); }
  catch (error) { console.warn("[ApiKeyQuotaReset] tick failed:", error.message); }
  finally { state.running = false; }
}

export function startApiKeyQuotaResetScheduler() {
  if (state.timer) return;
  runApiKeyQuotaResetTick();
  state.timer = setInterval(runApiKeyQuotaResetTick, INTERVAL_MS);
  state.timer.unref?.();
}
