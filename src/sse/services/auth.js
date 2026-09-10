import { recordRoutingDuration } from "@/lib/system/concurrency.js";
import { getApiKeyByValue, getProviderConnections, getProviderConnectionById, validateApiKey, updateProviderConnection, updateProviderConnectionHealth, getSettings, getMouses, getMouseExecutionDetails } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { checkApiKeyQuota } from "@/lib/apiKeyQuota.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import * as log from "../utils/logger.js";
import { canAccessWithTags, getModelAccessTags, normalizeAccessTags } from "@/shared/utils/accessTags.js";
import { incrementHotCounter } from "@/lib/redis/hotCache.js";
import { getStickyAssignment, claimStickyAssignment } from "@/lib/redis/stickyAssignments.js";
import { estimateRequestWeight, getConnectionConcurrencyLimit, reserveConnectionSlot } from "@/lib/redis/connectionSlots.js";
import { getProviderModelBreaker } from "./providerBreaker.js";

// Account selection is deliberately lock-free. The old per-provider mutex made
// every request wait behind a SQLite read and a lastUsedAt write. Assignment
// state is now kept in memory for sticky sessions, while non-sticky rotation
// uses a Redis counter when available.
const providerUserAssignments = new Map();
const providerLocalCursors = new Map();
const MAX_USER_ASSIGNMENTS_PER_PROVIDER = 1000;

export function resetProviderUserAssignments(providerId = null) {
  if (providerId) providerUserAssignments.delete(providerId);
  else providerUserAssignments.clear();
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

export async function authorizeModelAccess(provider, model, accessTags) {
  const requestAccessTags = Array.isArray(accessTags) ? normalizeAccessTags(accessTags) : null;
  if (requestAccessTags === null || !model) return null;

  const providerId = resolveProviderId(provider);
  const settings = await getSettings();
  const requiredModelTags = getModelAccessTags(
    settings.modelAccessTags,
    `${providerId}/${model}`,
    `${provider}/${model}`,
    model,
  );
  return canAccessWithTags(requestAccessTags, requiredModelTags)
    ? null
    : { accessDenied: true, resource: "model" };
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  const routingStarted = performance.now();
  const routingStartedAt = Date.now();
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestAccessTags = Array.isArray(options?.accessTags) ? normalizeAccessTags(options.accessTags) : null;

  // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
  const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers. Model tags still
    // apply even though there is no account record to authorize.
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      if (requestAccessTags !== null && model) {
        const settings = await getSettings();
        const requiredModelTags = getModelAccessTags(
          settings.modelAccessTags,
          `${providerId}/${model}`,
          `${provider}/${model}`,
          model,
        );
        if (!canAccessWithTags(requestAccessTags, requiredModelTags)) {
          log.warn("AUTH", `${provider}/${model} | denied by model access tags`);
          return { accessDenied: true, resource: "model" };
        }
      }

      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: false,
          connectionProxyUrl: "",
          connectionNoProxy: "",
        },
      };
    }

    const [connections, settings] = await Promise.all([
      getProviderConnections({ provider: providerId, isActive: true }), getSettings(),
    ]);
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    if (requestAccessTags !== null && model) {
      const requiredModelTags = getModelAccessTags(
        settings.modelAccessTags,
        `${providerId}/${model}`,
        `${provider}/${model}`,
        ...connections.map((connection) => connection.providerSpecificData?.prefix ? `${connection.providerSpecificData.prefix}/${model}` : ""),
        model,
      );
      if (!canAccessWithTags(requestAccessTags, requiredModelTags)) {
        log.warn("AUTH", `${provider}/${model} | denied by model access tags`);
        return { accessDenied: true, resource: "model" };
      }
    }

    // Account tags do not participate in authorization or routing. Account
    // selection only excludes failed/locked connections; API-key tags above
    // remain the permission boundary for models.
    const onlineMouses = new Map((await getMouses())
      .filter((mouse) => mouse.isOnline && !mouse.disabledAt && mouse.callbackUrl && mouse.executionTokenConfigured)
      .map((mouse) => [mouse.id, mouse]));
    const onlineMouseIds = new Set(onlineMouses.keys());

    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (c.mouseId && !onlineMouseIds.has(c.mouseId)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    const offlineMouseCount = connections.filter((c) => c.mouseId && !onlineMouseIds.has(c.mouseId)).length;
    if (offlineMouseCount) log.debug("AUTH", `${provider} | ${offlineMouseCount} connection(s) skipped: Mouse unavailable`);

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    if (model) {
      const breaker = await getProviderModelBreaker(providerId, model);
      if (breaker.open) {
        const retryAt = new Date(Date.now() + (breaker.retryAfterMs || 60_000)).toISOString();
        log.warn("BREAKER", `${provider}/${model} | provider/model cooling down (${formatRetryAfter(retryAt)})`);
        return {
          allRateLimited: true,
          retryAfter: retryAt,
          retryAfterHuman: formatRetryAfter(retryAt),
          lastError: "Provider model is temporarily cooling down after repeated failures",
          lastErrorCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
          breakerOpen: true,
        };
      }
    }

    // Account allocation belongs to the current provider/channel. A provider
    // without an explicit override always follows its connection priority.
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || "fill-first";

    let connection;
    // Pinning may bypass routing order, but never account permissions.
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      } else if (connections.some((candidate) => candidate.id === preferredConnectionId)) {
        log.warn("AUTH", `${provider} | preferred account unavailable; using the routing strategy`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      // Sticky assignments remain in memory; non-sticky rotation uses Redis.
      // No SQLite lastUsedAt write is needed on the request hot path.
      const requesterId = typeof options?.requesterId === "string" && options.requesterId ? options.requesterId : null;
      if (requesterId) {
        const state = providerUserAssignments.get(providerId) || { lastConnectionId: null, assignments: new Map() };
        const localAssignedId = state.assignments.get(requesterId);
        const redisAssignedId = await getStickyAssignment(providerId, requesterId);
        const assignedId = redisAssignedId || localAssignedId;
        connection = availableConnections.find((candidate) => candidate.id === assignedId);
        const outcome = connection ? "sticky-hit" : "rotated";

        if (!connection) {
          // Drop a stale sticky assignment before choosing a replacement. This
          // prevents repeated misses after a model lock and makes concurrent
          // retries converge on the newly selected account.
          if (assignedId) state.assignments.delete(requesterId);
          const lastIndex = availableConnections.findIndex((candidate) => candidate.id === state.lastConnectionId);
          connection = availableConnections[(lastIndex + 1 + availableConnections.length) % availableConnections.length];

          // Redis wins across workers. If another worker changed the mapping
          // while this request was selecting, use its current assignment when
          // it is still eligible instead of overwriting it blindly.
          const committedId = await claimStickyAssignment(
            providerId, requesterId, connection.id, redisAssignedId || null,
          );
          const committed = availableConnections.find((candidate) => candidate.id === committedId);
          if (committed) connection = committed;

          state.assignments.set(requesterId, connection.id);
          if (state.assignments.size > MAX_USER_ASSIGNMENTS_PER_PROVIDER) {
            state.assignments.delete(state.assignments.keys().next().value);
          }
        } else if (!redisAssignedId) {
          // Seed the shared assignment from the local fallback when Redis was
          // unavailable during the original request.
          await claimStickyAssignment(providerId, requesterId, connection.id, null);
        }
        state.lastConnectionId = connection.id;
        providerUserAssignments.set(providerId, state);
        const userLabel = requesterId === "local" ? "local" : log.maskKey(requesterId);
        log.routeLine(log.tagForSession(requesterId), "⚖️", `${provider} | user=${userLabel} | ${outcome} → ${connection.connectionName || connection.displayName || connection.name || connection.id.slice(0, 8)} | accounts=${availableConnections.length}`);
      } else {
        // Redis-backed cursor spreads anonymous callers across accounts without
        // writing lastUsedAt to SQLite on every request. Fall back to a local
        // cursor for development when Redis is unavailable.
        const redisCursor = await incrementHotCounter(`route-cursor:${providerId}`, 3600);
        const next = redisCursor ?? ((providerLocalCursors.get(providerId) || 0) + 1);
        providerLocalCursors.set(providerId, next);
        connection = availableConnections[(next - 1) % availableConnections.length];
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    // Only chat callers that own the full response lifecycle request a lease.
    // Media/model-list callers must not allocate slots they cannot release.
    let lease = null;
    if (options.reserveSlot === true) {
      const providerConfiguredLimit = providerOverride.providerMaxConcurrentStreams
        ?? PROVIDERS[providerId]?.transport?.providerMaxConcurrentStreams;
      const accountStrategy = providerOverride.maxConcurrentStreams == null
        && Number.isFinite(PROVIDERS[providerId]?.transport?.maxConcurrentStreams)
        ? { ...providerOverride, maxConcurrentStreams: PROVIDERS[providerId].transport.maxConcurrentStreams }
        : providerOverride;
      const preferredIndex = availableConnections.findIndex((candidate) => candidate.id === connection.id);
      const candidates = [...availableConnections.slice(preferredIndex), ...availableConnections.slice(0, preferredIndex)];
      lease = await reserveConnectionSlot(candidates.map((candidate) => ({
        id: candidate.id, limit: getConnectionConcurrencyLimit(candidate, accountStrategy),
      })), Number.isFinite(Number(providerConfiguredLimit)) ? {
        providerId,
        providerLimit: Number(providerConfiguredLimit),
        weight: options.requestWeight ?? estimateRequestWeight(options.body),
        queueTimeoutMs: providerOverride.queueTimeoutMs
          ?? PROVIDERS[providerId]?.transport?.queueTimeoutMs,
        maxQueueSize: providerOverride.maxQueueSize
          ?? PROVIDERS[providerId]?.transport?.maxQueueSize,
        signal: options.signal,
      } : {});
      connection = availableConnections.find((candidate) => candidate.id === lease.connectionId);
    }
    const mouseExecution = connection.mouseId ? await getMouseExecutionDetails(connection.mouseId) : null;
    if (connection.mouseId && !mouseExecution) {
      await lease?.release();
      return null;
    }
    let resolvedProxy;
    try {
      resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    } catch (error) {
      await lease?.release();
      throw error;
    }

    recordRoutingDuration(performance.now() - routingStarted);
    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      mouseExecution,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
      },
      connectionId: connection.id,
      // Used by clearAccountError to avoid an older in-flight success clearing
      // a lock written by a newer failure.
      _routingStartedAt: routingStartedAt,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection,
      releaseRouteSlot: lease?.release || null,
    };
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, upstreamError = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const isUpstream = upstreamError?.source === "http" || upstreamError?.source === "sse";

  let decision = { shouldFallback: false, cooldownMs: 0 };
  const applyFailure = (conn) => {
    const backoffLevel = conn?.backoffLevel || 0;
    const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

    let shouldFallback, cooldownMs, newBackoffLevel;
    if (githubResetAtMs) {
      shouldFallback = true;
      cooldownMs = githubResetAtMs - Date.now();
      newBackoffLevel = 0;
    } else if (resetsAtMs && resetsAtMs > Date.now()) {
      shouldFallback = true;
      cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
      newBackoffLevel = 0;
    } else if (Number.isFinite(upstreamError?.retryAfterMs) && upstreamError.retryAfterMs > 0) {
      shouldFallback = true;
      cooldownMs = Math.min(upstreamError.retryAfterMs, MAX_RATE_LIMIT_COOLDOWN_MS);
      newBackoffLevel = 0;
    } else {
      ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
    }
    decision = { shouldFallback, cooldownMs };
    if (!shouldFallback) return { value: decision };

    const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
    const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);
    const lockKey = Object.keys(lockUpdate)[0];
    const oldExpiry = conn?.[lockKey];
    if (oldExpiry && new Date(oldExpiry).getTime() > new Date(lockUpdate[lockKey]).getTime()) {
      lockUpdate[lockKey] = oldExpiry;
    }

    return {
      value: { ...decision, lockKey, reason, status },
      update: {
        ...lockUpdate,
        testStatus: status === 429 ? "limited" : status >= 500 ? "degraded" : "unavailable",
        backoffLevel: newBackoffLevel ?? backoffLevel,
        healthRevision: (conn?.healthRevision || 0) + 1,
        ...(isUpstream ? {
          lastUpstreamError: String(upstreamError.message || reason).slice(0, 2000),
          lastUpstreamStatus: upstreamError.status ?? status,
          lastUpstreamSource: upstreamError.source,
          lastUpstreamRaw: String(upstreamError.body || reason).slice(0, 4000),
          lastUpstreamAt: upstreamError.receivedAt || new Date().toISOString(),
          lastError: String(upstreamError.message || reason).slice(0, 2000),
          errorCode: upstreamError.status ?? status,
          lastErrorAt: upstreamError.receivedAt || new Date().toISOString(),
        } : {
          gatewayError: reason,
          gatewayErrorCode: status,
          gatewayErrorAt: new Date().toISOString(),
        }),
      },
    };
  };

  if (typeof updateProviderConnectionHealth === "function") {
    const result = await updateProviderConnectionHealth(connectionId, applyFailure);
    if (!result || !decision.shouldFallback) return decision;
    const connName = result.reason ? (result.connectionName || connectionId.slice(0, 8)) : connectionId.slice(0, 8);
    log.warn("AUTH", `${connName} locked ${result.lockKey} for ${Math.round(result.cooldownMs / 1000)}s [${status}]`);
  } else {
    // Compatibility fallback for isolated test doubles and older route bundles.
    const connections = await getProviderConnections({ provider });
    const result = applyFailure(connections.find(c => c.id === connectionId));
    if (!result.update) return decision;
    await updateProviderConnection(connectionId, result.update);
    log.warn("AUTH", `${connectionId.slice(0, 8)} locked ${Object.keys(result.update).find(k => k.startsWith("modelLock_"))} for ${Math.round(decision.cooldownMs / 1000)}s [${status}]`);
  }

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  if (provider && status && reason) console.error(`❌ ${provider} [${status}]: ${reason}`);
  return decision;
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const requestStartedAt = Number(currentConnection._routingStartedAt || 0);
  const clearFailure = (conn) => {
    const now = Date.now();
    const latestFailureAt = conn.lastErrorAt ? new Date(conn.lastErrorAt).getTime() : 0;
    const newerFailureInFlight = requestStartedAt > 0 && latestFailureAt > requestStartedAt;
    const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));
    if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return { value: null };

    const keysToClear = allLockKeys.filter(k => {
      if (newerFailureInFlight) return conn[k] && new Date(conn[k]).getTime() <= now;
      if (model && (k === `modelLock_${model}` || k === "modelLock___all")) return true;
      return conn[k] && new Date(conn[k]).getTime() <= now;
    });
    if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return { value: null };

    const remainingActiveLocks = allLockKeys.filter(k => !keysToClear.includes(k) && conn[k] && new Date(conn[k]).getTime() > now);
    const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));
    if (remainingActiveLocks.length === 0) {
      Object.assign(clearObj, { testStatus: "active", lastError: null, errorCode: null, lastErrorAt: null, backoffLevel: 0 });
    }
    return { value: true, update: clearObj };
  };

  if (typeof updateProviderConnectionHealth === "function") {
    await updateProviderConnectionHealth(connectionId, clearFailure);
    return;
  }
  const conn = (await getProviderConnectionById?.(connectionId)) || currentConnection._connection || currentConnection;
  const result = clearFailure(conn);
  if (result.update) await updateProviderConnection(connectionId, result.update);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // OpenAI-compatible clients normally use Authorization: Bearer <key>.
  // Accept the common provider SDK variants too, because the router key is an
  // ingress credential regardless of the client protocol.
  const authHeader = request.headers.get("Authorization");
  const bearerMatch = authHeader?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1].trim();

  for (const header of ["x-api-key", "api-key", "x-goog-api-key"]) {
    const value = request.headers.get(header);
    if (value?.trim()) return value.trim();
  }

  // Gemini SDKs also support ?key=<key> / ?api_key=<key>. The URL value is
  // only used as an ingress key and is still validated before enforcement.
  try {
    const url = new URL(request.url);
    const queryKey = url.searchParams.get("key") || url.searchParams.get("api_key");
    if (queryKey?.trim()) return queryKey.trim();
  } catch {}

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

export async function resolveApiKeyAccessTags(apiKey) {
  if (!apiKey) return [];
  const [key, settings] = await Promise.all([getApiKeyByValue(apiKey), getSettings()]);
  return normalizeAccessTags(settings.apiKeyAccessTags?.[key?.id]);
}

function quotaResponse(status) {
  const window = status.exceededWindow;
  const retryAfterSeconds = window?.resetAt
    ? Math.max(1, Math.ceil((new Date(window.resetAt).getTime() - Date.now()) / 1000))
    : 3600;

  return new Response(
    JSON.stringify({
      error: {
        message: `API key quota exceeded (${window?.label || "current window"}); resets at ${window?.resetAt || "the next successful-window roll"}`,
        type: "rate_limit_error",
        code: "api_key_quota_exceeded",
      },
    }),
    {
      status: HTTP_STATUS.RATE_LIMITED,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Validate an ingress key and enforce the instance-wide key quota when that key
 * has opted in. Returns a Response only when the request must be rejected.
 */
export async function authorizeApiKey(apiKey, { requireApiKey = false } = {}) {
  if (!apiKey) return requireApiKey ? errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") : null;

  // A supplied credential must always resolve to a configured key. Otherwise a
  // remote request could pass when enforcement is off and later be persisted as
  // an unidentifiable "external" caller.
  if (!(await isValidApiKey(apiKey))) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  const quota = await checkApiKeyQuota(apiKey);
  return quota.allowed ? null : quotaResponse(quota.status);
}
