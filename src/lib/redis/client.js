import { createClient } from "redis";

const REDIS_URL = process.env.SPRING_MOUSE_REDIS_URL || "";
const REDIS_REQUIRED = process.env.SPRING_MOUSE_REDIS_REQUIRED === "true";

if (!global.__springMouseRedis) {
  global.__springMouseRedis = {
    client: null,
    connectPromise: null,
    lastError: null,
    lastConnectedAt: null,
  };
}

const state = global.__springMouseRedis;

export function isRedisConfigured() {
  return Boolean(REDIS_URL);
}

export function parseRedisInfo(info = "") {
  const fields = {};
  for (const line of String(info).split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
}

function numericInfoField(fields, key) {
  const value = Number(fields?.[key]);
  return Number.isFinite(value) ? value : null;
}

export async function getRedisClient({ required = REDIS_REQUIRED } = {}) {
  if (!REDIS_URL) {
    if (required) throw new Error("Embedded Redis is required but SPRING_MOUSE_REDIS_URL is not configured");
    return null;
  }

  if (state.client?.isReady) return state.client;
  if (state.connectPromise) return state.connectPromise;

  const client = state.client || createClient({
    url: REDIS_URL,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy(retries) {
        return Math.min(50 * 2 ** Math.min(retries, 5), 1000);
      },
    },
  });

  if (!state.client) {
    client.on("error", (error) => {
      state.lastError = error?.message || String(error);
    });
    client.on("ready", () => {
      state.lastError = null;
      state.lastConnectedAt = new Date().toISOString();
    });
    state.client = client;
  }

  state.connectPromise = client.connect()
    .then(() => client)
    .catch((error) => {
      state.lastError = error?.message || String(error);
      if (required) throw error;
      return null;
    })
    .finally(() => {
      state.connectPromise = null;
    });

  return state.connectPromise;
}

export async function getRedisHealth() {
  if (!REDIS_URL) return { configured: false, connected: false };
  try {
    const client = await getRedisClient({ required: false });
    if (!client) return { configured: true, connected: false, error: state.lastError };
    const started = performance.now();
    await client.ping();
    const latencyMs = Number((performance.now() - started).toFixed(1));
    const [memoryResult, persistenceResult, keyCountResult] = await Promise.allSettled([
      client.info("memory"),
      client.info("persistence"),
      client.dbSize(),
    ]);
    const memoryInfo = memoryResult.status === "fulfilled" ? parseRedisInfo(memoryResult.value) : {};
    const persistenceInfo = persistenceResult.status === "fulfilled" ? parseRedisInfo(persistenceResult.value) : {};
    const metricsError = [memoryResult, persistenceResult, keyCountResult]
      .find((result) => result.status === "rejected")?.reason;

    return {
      configured: true,
      connected: true,
      latencyMs,
      lastConnectedAt: state.lastConnectedAt,
      keyCount: keyCountResult.status === "fulfilled" ? Number(keyCountResult.value) || 0 : null,
      memory: {
        usedBytes: numericInfoField(memoryInfo, "used_memory"),
        rssBytes: numericInfoField(memoryInfo, "used_memory_rss"),
        maxBytes: numericInfoField(memoryInfo, "maxmemory"),
        fragmentationRatio: numericInfoField(memoryInfo, "mem_fragmentation_ratio"),
      },
      persistence: {
        aofEnabled: persistenceInfo.aof_enabled === "1",
        aofSizeBytes: numericInfoField(persistenceInfo, "aof_current_size"),
      },
      metricsError: metricsError?.message || null,
      error: null,
    };
  } catch (error) {
    return { configured: true, connected: false, error: error?.message || String(error) };
  }
}

export async function closeRedisClient() {
  const client = state.client;
  state.client = null;
  if (!client?.isOpen) return;
  try { await client.quit(); } catch { try { client.destroy(); } catch {} }
}
