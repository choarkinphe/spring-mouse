import { createClient } from "redis";

// Keep best-effort routing/cache traffic separate from the durable usage queue.
// A wedged socket must not stall every Codex window or replay queued cache writes.
const positive = (value, fallback) => Math.max(1, Number.parseInt(value, 10) || fallback);
export const ROUTING_REDIS_TIMEOUT_MS = positive(process.env.SPRING_MOUSE_ROUTING_REDIS_TIMEOUT_MS, 200);
const BACKOFF_MS = 1000;
const state = globalThis.__smRoutingRedis ||= { client: null, connecting: null, retryAt: 0, timeouts: 0, errors: 0 };

function discard(client) {
  if (state.client !== client) return;
  state.client = null;
  state.connecting = null;
  state.retryAt = Date.now() + BACKOFF_MS;
  try { client?.destroy(); } catch { /* already closed */ }
}

async function readyClient() {
  const url = process.env.SPRING_MOUSE_REDIS_URL;
  if (!url || Date.now() < state.retryAt) return null;
  if (state.client?.isReady) return state.client;
  if (state.connecting) return state.connecting;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 2048,
    socket: { connectTimeout: ROUTING_REDIS_TIMEOUT_MS, reconnectStrategy: false },
  });
  client.on("error", () => { state.errors++; discard(client); });
  state.client = client;
  state.connecting = client.connect().then(() => client).catch(() => {
    discard(client);
    return null;
  }).finally(() => { if (state.client === client) state.connecting = null; });
  return state.connecting;
}

/** One bounded operation; null means unavailable. Never retries a mutation. */
export async function routingRedis(operation) {
  let timer;
  let timedOut = false;
  let operationClient = null;
  try {
    return await Promise.race([
      (async () => {
        const ready = readyClient();
        operationClient = state.client;
        const client = await ready;
        if (!client || timedOut) return null;
        return await operation(client);
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          state.timeouts++;
          discard(operationClient);
          resolve(null);
        }, ROUTING_REDIS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    state.errors++;
    discard(operationClient);
    return null;
  } finally { clearTimeout(timer); }
}

export function getRoutingRedisStatus() {
  return { connected: !!state.client?.isReady, timeoutMs: ROUTING_REDIS_TIMEOUT_MS, timeouts: state.timeouts, errors: state.errors };
}

export function closeRoutingRedis() {
  discard(state.client);
  state.retryAt = 0;
}
