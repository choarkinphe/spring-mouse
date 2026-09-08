import { createHash } from "node:crypto";
import { runWithAbortDeadline } from "../../utils/abortable.js";
import { TOKEN_REFRESH_TIMEOUT_MS } from "../../config/runtimeConfig.js";

const REFRESH_RESULT_TTL_MS = 10_000;
const MAX_REFRESH_RESULTS = 1000;
const refreshDedupCache = new Map();
// Separate settled results from active refreshes: capacity eviction must not
// start duplicate refreshes while the upstream is still processing a token.
const recentResults = new Map();
let cleanupTimer = null;

function scheduleCleanup() {
  if (cleanupTimer || recentResults.size === 0) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    const now = Date.now();
    for (const [key, entry] of recentResults) {
      if (entry.expiresAt <= now) recentResults.delete(key);
    }
    scheduleCleanup();
  }, REFRESH_RESULT_TTL_MS);
  cleanupTimer.unref?.();
}

export async function dedupRefresh(provider, oldToken, fn, log, { timeoutMs = TOKEN_REFRESH_TIMEOUT_MS } = {}) {
  if (!oldToken) return fn();
  // The old rotating credential is never needed after deriving its identity.
  const key = createHash("sha256").update(JSON.stringify([provider, oldToken])).digest("hex");
  const pending = refreshDedupCache.get(key);
  if (pending) {
    log?.info?.("TOKEN_REFRESH", `Reusing in-flight refresh for ${provider}`);
    return pending;
  }
  const hit = recentResults.get(key);
  if (hit?.expiresAt > Date.now()) {
    log?.info?.("TOKEN_REFRESH", `Reusing recent refresh result for ${provider}`);
    return hit.result;
  }
  recentResults.delete(key);

  // Defer invocation until the pending entry exists, including synchronous
  // throws. Otherwise a rejection can be cached AFTER its cleanup has run.
  const controller = new AbortController();
  const promise = runWithAbortDeadline(() => fn(controller.signal), {
    timeoutMs,
    timeoutMessage: "Credential refresh deadline exceeded",
    onTimeout: (error) => controller.abort(error),
  }).then((result) => {
    recentResults.set(key, { result, expiresAt: Date.now() + REFRESH_RESULT_TTL_MS });
    if (recentResults.size > MAX_REFRESH_RESULTS) recentResults.delete(recentResults.keys().next().value);
    scheduleCleanup();
    return result;
  }).catch((error) => {
    if (!controller.signal.aborted) throw error;
    // Match provider refresh failure semantics. Never cache timeout/late results.
    log?.warn?.("TOKEN_REFRESH", `Refresh timed out for ${provider}`);
    return null;
  }).finally(() => {
    if (refreshDedupCache.get(key) === promise) refreshDedupCache.delete(key);
  });
  refreshDedupCache.set(key, promise);
  return promise;
}

export const __test__ = { cacheSize: () => refreshDedupCache.size + recentResults.size };
