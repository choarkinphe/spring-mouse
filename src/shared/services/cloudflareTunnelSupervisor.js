import { getSettings } from "@/lib/localDb";
import {
  getCloudflareTunnelStatus,
  refreshCloudflareTunnelConnection,
  startCloudflareTunnel,
} from "@/lib/tunnel/cloudflare/cloudflared";

export const INITIAL_RETRY_DELAY_MS = 3_000;
export const MAX_RETRY_DELAY_MS = 30_000;
export const HEALTH_CHECK_DELAY_MS = 15_000;

function scheduleUnref(fn, delayMs) {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return timer;
}

/**
 * Keeps the persisted Cloudflare Tunnel desired state running.
 *
 * cloudflared reconnects transient edge connections by itself. This supervisor
 * additionally covers the cases where the process cannot start during Docker
 * boot or exits later, without making the HTTP server wait for the tunnel.
 */
export function createCloudflareTunnelSupervisor({
  loadSettings = getSettings,
  getStatus = getCloudflareTunnelStatus,
  refreshConnection = refreshCloudflareTunnelConnection,
  startTunnel = startCloudflareTunnel,
  schedule = scheduleUnref,
  log = console,
} = {}) {
  let timer = null;
  let active = false;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;
  let attempt = 0;
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
        if (settings?.cloudflareTunnelEnabled !== true) {
          retryDelayMs = INITIAL_RETRY_DELAY_MS;
          attempt = 0;
          scheduleNext(HEALTH_CHECK_DELAY_MS);
          return;
        }

        if (getStatus(settings).running) {
          await refreshConnection();
          retryDelayMs = INITIAL_RETRY_DELAY_MS;
          attempt = 0;
          scheduleNext(HEALTH_CHECK_DELAY_MS);
          return;
        }

        attempt += 1;
        const status = await startTunnel(settings);
        if (!status?.running) throw new Error("cloudflared did not report a running tunnel");
        await refreshConnection();

        retryDelayMs = INITIAL_RETRY_DELAY_MS;
        attempt = 0;
        log.info?.(`[Cloudflare Tunnel] started${status.publicUrl ? `: ${status.publicUrl}` : ""}`);
        scheduleNext(HEALTH_CHECK_DELAY_MS);
      } catch (error) {
        const delayMs = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
        const message = error?.message || String(error);
        log.warn?.(`[Cloudflare Tunnel] start attempt ${attempt || 1} failed; retrying in ${Math.round(delayMs / 1000)}s: ${message}`);
        scheduleNext(delayMs);
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
      return check();
    },
    stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    check,
  };
}

const globalRuntime = globalThis.__springMouseCloudflareTunnelSupervisor ??= {
  supervisor: null,
};

export function startCloudflareTunnelSupervisor() {
  if (!globalRuntime.supervisor) {
    globalRuntime.supervisor = createCloudflareTunnelSupervisor();
  }
  globalRuntime.supervisor.start();
}

export function stopCloudflareTunnelSupervisor() {
  globalRuntime.supervisor?.stop();
}
