// Process-local cache for the expensive rolling API-key quota aggregate.
// Kept in its own dependency-free module so usage writes can invalidate it
// without creating a db-repository ↔ quota-service import cycle.
const QUOTA_TTL_MS = 10000;
const QUOTA_CACHE_MAX_SIZE = 1000;

const statusCache = new Map();
const statusLoads = new Map();
let cacheGeneration = 0;

function trimCache() {
  if (statusCache.size <= QUOTA_CACHE_MAX_SIZE) return;
  const entries = Array.from(statusCache.entries());
  statusCache.clear();
  entries.slice(-Math.floor(QUOTA_CACHE_MAX_SIZE / 2)).forEach(([key, value]) => {
    statusCache.set(key, value);
  });
}

export function getCachedQuotaStatus(apiKey, now = Date.now()) {
  const cached = statusCache.get(apiKey);
  return cached && now - cached.timestamp < QUOTA_TTL_MS ? cached.status : null;
}

export function getQuotaStatusLoad(apiKey) {
  return statusLoads.get(apiKey) || null;
}

export function setQuotaStatusLoad(apiKey, load) {
  statusLoads.set(apiKey, load);
}

export function clearQuotaStatusLoad(apiKey, load) {
  if (statusLoads.get(apiKey) === load) statusLoads.delete(apiKey);
}

export function getQuotaCacheGeneration() {
  return cacheGeneration;
}

export function cacheQuotaStatus(apiKey, status, generation, timestamp = Date.now()) {
  if (generation !== cacheGeneration) return;
  statusCache.set(apiKey, { status, timestamp });
  trimCache();
}

export function invalidateQuotaCache(apiKey = null) {
  cacheGeneration += 1;
  if (apiKey) {
    statusCache.delete(apiKey);
    statusLoads.delete(apiKey);
  } else {
    statusCache.clear();
    statusLoads.clear();
  }
}
