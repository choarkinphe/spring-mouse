// Best-effort telemetry only. Never use this queue for billing/quota usage.
// A stalled sink keeps ONE worker occupied; do not race it and spawn more
// unabortable DB operations on every timeout.
export function createTrafficWriter(save, { maxRecords = 256, maxBytes = 1024 * 1024 } = {}) {
  const queue = [];
  let queuedBytes = 0;
  let running = false;
  let scheduled = null;
  let inFlight = 0;
  let dropped = 0;
  let persisted = 0;
  let failed = 0;
  let lastWarning = -Infinity;

  const warn = () => {
    if (Date.now() - lastWarning < 60_000) return;
    lastWarning = Date.now();
    console.warn("[Traffic] Persistence degraded", { dropped, failed, queued: queue.length });
  };
  const schedule = () => {
    if (running || scheduled || !queue.length) return;
    // Give the completed response a chance to finish before synchronous DB work.
    scheduled = setImmediate(() => { scheduled = null; void drain(); });
    scheduled.unref?.();
  };
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      // Yield between batches instead of monopolizing the event loop on bursts.
      for (let n = 0; n < 20 && queue.length; n++) {
        const item = queue.shift();
        queuedBytes -= item.bytes;
        inFlight = 1;
        try {
          await save(JSON.parse(item.json));
          persisted++;
        } catch {
          failed++;
          warn();
        } finally { inFlight = 0; }
      }
    } finally {
      running = false;
      schedule();
    }
  };

  return {
    enqueue(record) {
      try {
        // Detached, small schema: never queue a Request, body or arbitrary meta.
        const text = (value, max) => typeof value === "string" ? value.slice(0, max) : null;
        const number = (value) => Number.isFinite(value) ? value : 0;
        const json = JSON.stringify({
          requestId: text(record.requestId, 64), timestamp: text(record.timestamp, 32),
          completedAt: text(record.completedAt, 32), method: text(record.method, 16),
          endpoint: text(record.endpoint, 1024), statusCode: number(record.statusCode),
          requestBytes: number(record.requestBytes), responseBytes: number(record.responseBytes),
          durationMs: number(record.durationMs), aborted: record.aborted === true,
          meta: {
            sourceIp: text(record.meta?.sourceIp, 128), appName: text(record.meta?.appName, 64),
            userAgent: text(record.meta?.userAgent, 256), sourceUrl: text(record.meta?.sourceUrl, 256),
          },
        });
        // Conservative UTF-16 storage budget, not a claim about exact V8 RSS.
        const bytes = json.length * 2;
        if (bytes > maxBytes) { dropped++; warn(); return false; }
        while (queue.length && (queue.length >= maxRecords || queuedBytes + bytes > maxBytes)) {
          queuedBytes -= queue.shift().bytes;
          dropped++;
          warn();
        }
        queue.push({ json, bytes });
        queuedBytes += bytes;
        schedule();
        return true;
      } catch {
        dropped++;
        warn();
        return false;
      }
    },
    stats: () => ({ queued: queue.length, queuedBytes, inFlight, dropped, failed, persisted }),
  };
}
