import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { resolveUsageDashboardScope } from "@/lib/usageDashboardScope";

export const dynamic = "force-dynamic";

const FULL_REFRESH_MIN_INTERVAL_MS = 5_000;

export async function GET(request) {
  const encoder = new TextEncoder();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "today";
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const apiKeyId = searchParams.get("apiKeyId") || null;
  let apiKeyIds = null;
  const state = {
    closed: false,
    keepalive: null,
    refreshTimer: null,
    send: null,
    sendPending: null,
    cachedStats: null,
    pendingSnapshot: null,
    pendingPatch: null,
    controller: null,
    refreshRunning: false,
    refreshQueued: false,
    pendingRunning: false,
    lastRefreshCompletedAt: 0,
  };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    state.refreshQueued = false;
    state.cachedStats = null;
    state.pendingSnapshot = null;
    state.pendingPatch = null;
    try { state.controller?.close(); } catch {}
    state.controller = null;
    if (state.send) statsEmitter.off("update", state.send);
    if (state.sendPending) statsEmitter.off("pending", state.sendPending);
    if (state.keepalive) clearInterval(state.keepalive);
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    request.signal.removeEventListener("abort", cleanup);
  };

  request.signal.addEventListener("abort", cleanup, { once: true });

  const write = (controller, data) => {
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      state.controller = controller;
      if (request.signal.aborted) { cleanup(); return; }
      const enqueue = (data) => {
        if (state.closed) return false;
        // Dashboard events are replaceable snapshots, not a lossless event
        // log. A slow reader gets the latest full snapshot and live patch,
        // instead of an unbounded queue of serialized historical updates.
        if (controller.desiredSize <= 0) {
          if (data.streamPatch) state.pendingPatch = data;
          else {
            state.pendingSnapshot = data;
            state.pendingPatch = null;
          }
          return true;
        }
        return write(controller, data);
      };

      const sendLivePatch = async () => {
        if (state.closed || !state.cachedStats || state.pendingRunning) return;
        state.pendingRunning = true;
        try {
          const liveApiKeyFilter = Array.isArray(apiKeyIds) ? apiKeyIds : apiKeyId;
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests(liveApiKeyFilter);
          if (state.closed) return;
          enqueue({ streamPatch: true, activeRequests, recentRequests, errorProvider });
        } catch {
          cleanup();
        } finally {
          state.pendingRunning = false;
        }
      };

      const runFullRefresh = async () => {
        if (state.closed || state.refreshRunning) return;
        state.refreshRunning = true;
        state.refreshQueued = false;
        try {
          ({ apiKeyIds } = await resolveUsageDashboardScope(apiKeyId));
          const statsRange = { startDate, endDate, apiKeyId, apiKeyIds };
          const stats = { ...(await getUsageStats(period, statsRange)), streamUpdatedAt: Date.now() };
          if (state.closed) return;
          state.cachedStats = stats;
          enqueue(stats);
        } catch {
          cleanup();
        } finally {
          state.refreshRunning = false;
          state.lastRefreshCompletedAt = Date.now();
          if (state.refreshQueued && !state.closed) scheduleFullRefresh();
        }
      };

      const scheduleFullRefresh = () => {
        if (state.closed) return;
        if (state.refreshRunning) {
          state.refreshQueued = true;
          return;
        }

        const delay = Math.max(0, state.lastRefreshCompletedAt + FULL_REFRESH_MIN_INTERVAL_MS - Date.now());
        if (delay === 0) {
          void runFullRefresh();
          return;
        }

        state.refreshQueued = true;
        if (state.refreshTimer) return;
        state.refreshTimer = setTimeout(() => {
          state.refreshTimer = null;
          if (state.closed || !state.refreshQueued) return;
          void runFullRefresh();
        }, delay);
        state.refreshTimer.unref?.();
      };

      // Completed requests refresh the small live section immediately, while
      // expensive aggregate scans are single-flight and capped at once per 5s.
      state.send = () => {
        void sendLivePatch();
        scheduleFullRefresh();
      };
      state.sendPending = () => { void sendLivePatch(); };

      await runFullRefresh();
      if (state.closed) return;

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        if (controller.desiredSize <= 0) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
      state.keepalive.unref?.();
    },

    pull(controller) {
      if (state.closed) return;
      if (state.pendingSnapshot) {
        const data = state.pendingSnapshot;
        state.pendingSnapshot = null;
        write(controller, data);
      } else if (state.pendingPatch) {
        const data = state.pendingPatch;
        state.pendingPatch = null;
        write(controller, data);
      }
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
