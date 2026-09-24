import { randomUUID } from "node:crypto";
import { withRouteLease } from "../services/routeLease.js";
import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  authorizeApiKey,
  resolveApiKeyAccessTags,
} from "../services/auth.js";
import { getSettings, getComboByName } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities, getComboModelsForRequest, getUnsupportedComboRequestCapability } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS, REQUEST_OVERLOAD_BUDGET_MS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { getRequestSourceMeta } from "@/shared/utils/requestSource";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getTrafficRequestId } from "@/lib/networkTraffic.js";
import { clearProviderModelBreaker, recordProviderModelFailure } from "../services/providerBreaker.js";
import { REQUEST_LOGS_DIR } from "@/lib/requestLogPath.js";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import { canAccessWithTags } from "@/shared/utils/accessTags";

function resolveComboRequestModels(comboModels, requiredCapabilities, capabilities) {
  const unsupported = getUnsupportedComboRequestCapability(requiredCapabilities, capabilities);
  if (unsupported) return { error: `Combo does not declare ${unsupported} input support` };

  const models = getComboModelsForRequest(comboModels, requiredCapabilities, capabilities);
  if (models.length === 0) return { error: "No active combo model can handle this request's declared inputs" };
  return { models };
}

// Model-level overload retries are configured per provider strategy. The cap keeps a
// malformed or overly generous setting from turning one request into an unbounded
// fan-out across accounts.
const OVERLOAD_MAX_RETRIES_DEFAULT = 1;
const OVERLOAD_MAX_RETRIES_CAP = 10;
// Hint handed back to the client when we stop fanning out on a busy model. Short
// on purpose: the model throttle clears in seconds, so telling the caller to wait
// a minute (the old breaker wording) made every client back off far too long.
const MODEL_LEVEL_RETRY_HINT_MS = 5_000;

export function resolveOverloadMaxRetries(strategy = {}) {
  const raw = strategy?.overloadMaxRetries;
  if (raw == null || raw === "") return OVERLOAD_MAX_RETRIES_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return OVERLOAD_MAX_RETRIES_DEFAULT;
  return Math.min(parsed, OVERLOAD_MAX_RETRIES_CAP);
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    const sourceMeta = getRequestSourceMeta(request);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries()),
      ...sourceMeta,
    };
  }
  const modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Resolve supplied keys even when enforcement is off. Besides making the
  // optional guard accurate, this records last-used time and lets the live
  // topology show the configured API key name instead of an anonymous caller.
  const settings = await getSettings();
  const authFailure = await authorizeApiKey(apiKey, { requireApiKey: settings.requireApiKey === true, meter: true, signal: request.signal, model: modelStr });
  if (authFailure) return authFailure;
  const accessTags = await resolveApiKeyAccessTags(apiKey);

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  await refreshModelCapabilityOverrides().catch((error) => {
    log.warn("CAPABILITIES", `Failed to load synchronized model capabilities: ${error.message}`);
  });

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // One overload-retry deadline for the whole client request, shared by every
  // model the combo tries. The executor's per-model budget is right for a single
  // model, but the GPT combo chains 3-6 models that all resolve to the same
  // upstream (cx/...), so a per-model budget multiplies: 90s x 5 = 450s, far past
  // the 165s clients were measured to tolerate. Capping the total keeps the retry
  // useful without letting one saturated upstream hold the request open.
  const overloadDeadline = Date.now() + REQUEST_OVERLOAD_BUDGET_MS;

  // Combo routing is self-contained: its declared capability metadata must
  // match at least one of its own members. No global cross-combo pool is used.
  const comboModels = await getComboModels(modelStr, accessTags);
  if (comboModels) {
    const combo = await getComboByName(modelStr);
    if (!canAccessWithTags(accessTags, combo?.accessTags)) {
      log.warn("AUTH", `${modelStr} | denied by combo access tags`);
      return errorResponse(HTTP_STATUS.FORBIDDEN, "This model is not available for this API key");
    }
    const resolved = resolveComboRequestModels(comboModels, requiredCapabilities, combo?.capabilities);
    if (resolved.error) return errorResponse(HTTP_STATUS.BAD_REQUEST, resolved.error);

    const comboStrategies = settings.comboStrategies || {};
    const comboConfig = comboStrategies[modelStr] || {};
    const comboStrategy = comboConfig.fallbackStrategy || "fallback";
    const routedModels = resolved.models;

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${routedModels.length} compatible models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: routedModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, accessTags, overloadDeadline);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = comboConfig.stickyRoundRobinLimit || 1;
    log.info("CHAT", `Combo "${modelStr}" with ${routedModels.length} compatible models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: routedModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, accessTags, overloadDeadline),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, accessTags, overloadDeadline);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, accessTags = [], overloadDeadline = null) {
  const modelInfo = await getModelInfo(modelStr);
  const requestStartTime = Date.now();
  // One id for this client request, shared by the routing log lines, the usage
  // row, and every retry inside the loop below. chatCore used to mint its own id
  // that never reached a log line, so a specific failure could not be tied back
  // to the account/lock/breaker events it caused.
  const requestId = randomUUID();
  const reqPrefix = `[${requestId.slice(0, 8)}] `;

  // A request rejected before an upstream account is chosen used to leave no
  // trace in the database: usageHistory only ever saw requests that reached the
  // chat pipeline, so "why are so few requests getting through?" could only be
  // answered from the 200-line in-memory log buffer.
  //
  // The terminal status is now an explicit namespace so the two failure origins
  // can never be conflated again (they were both "rejected" before, which read as
  // "spring-mouse broke" even when the upstream was the one answering with 5xx):
  //   upstream:<code>   — the upstream answered with an error status
  //   blocked:<reason>  — spring-mouse's own routing policy stopped the request
  // Neither is counted against API-key quota (usageRepo only charges success/ok),
  // and the startedAt→completedAt span still shows how long a request queued.
  const saveOutcome = (status) => {
    if (!request) return;
    let endpoint = clientRawRequest?.endpoint || null;
    if (!endpoint) {
      try { endpoint = new URL(request.url).pathname; } catch { endpoint = null; }
    }
    return saveRequestUsage({
      requestId,
      trafficRequestId: getTrafficRequestId(request),
      startedAt: new Date(requestStartTime).toISOString(),
      completedAt: new Date().toISOString(),
      provider: modelInfo.provider || null,
      model: modelInfo.model || null,
      connectionId: null,
      apiKey,
      endpoint,
      ...getRequestSourceMeta(request),
      tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      status,
    }).catch(() => {});
  };

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr, accessTags);
    if (comboModels) {
      const combo = await getComboByName(modelStr);
      if (!canAccessWithTags(accessTags, combo?.accessTags)) {
        log.warn("AUTH", `${modelStr} | denied by combo access tags`);
        return errorResponse(HTTP_STATUS.FORBIDDEN, "This model is not available for this API key");
      }
      const chatSettings = await getSettings();
      const requiredCapabilities = detectRequiredCapabilities(body);
      const resolved = resolveComboRequestModels(comboModels, requiredCapabilities, combo?.capabilities);
      if (resolved.error) return errorResponse(HTTP_STATUS.BAD_REQUEST, resolved.error);

      const comboStrategies = chatSettings.comboStrategies || {};
      const comboConfig = comboStrategies[modelStr] || {};
      const comboStrategy = comboConfig.fallbackStrategy || "fallback";
      const routedModels = resolved.models;

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${routedModels.length} compatible models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: routedModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, accessTags, overloadDeadline);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = comboConfig.stickyRoundRobinLimit || 1;
      log.info("CHAT", `Combo "${modelStr}" with ${routedModels.length} compatible models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: routedModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, accessTags, overloadDeadline),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
      });
    }

    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  const routingSettings = await getSettings();
  const overloadMaxRetries = resolveOverloadMaxRetries(
    (routingSettings.providerStrategies || {})[provider],
  );

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  // Subset of `excludeConnectionIds` holding accounts excluded ONLY because the
  // upstream model was busy. A model-level signal says nothing about the account,
  // so when the pool drains purely for that reason the exclusions can be lifted
  // and the pool retried, with `overloadMaxRetries` as the bound. Account-level
  // failures (bad key, per-account rate limit) are never in this set and stay
  // excluded.
  const modelLevelExcluded = new Set();
  let lastError = null;
  let lastStatus = null;
  // Counts accounts that reported a *model-level* problem (the upstream model is
  // busy). Fanning out to the whole pool on such a signal multiplies the errors
  // we send at an upstream that is already saturated, so it is capped.
  let modelLevelFailures = 0;

  while (true) {
    if (request?.signal?.aborted) return errorResponse(499, "Request aborted");
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
        accessTags, requesterId: apiKey || "local", reserveSlot: true, body, signal: request?.signal, requestId,
      });
    } catch (error) {
      if (error?.code !== "ROUTING_QUEUE_TIMEOUT") throw error;
      // Report what actually happened: how long this request waited, and how
      // long the caller should back off before trying again.
      const waitedMs = error.queueTimeoutMs ?? error.retryAfterMs;
      const retryAfterMs = error.retryAfterMs;
      const retryAfterHuman = `retry after ${Math.ceil(retryAfterMs / 1000)}s`;
      log.warn("CONCURRENCY", `${reqPrefix}${provider}/${model} | queue timeout after ${waitedMs}ms (${retryAfterHuman})`);
      saveOutcome("blocked:queue_timeout");
      return unavailableResponse(
        HTTP_STATUS.RATE_LIMITED,
        `${provider}/${model} is at the configured concurrency limit`,
        new Date(Date.now() + retryAfterMs).toISOString(),
        retryAfterHuman,
      );
    }

    if (credentials?.aborted) return errorResponse(499, "Request aborted");

    // All accounts unavailable
    if (credentials?.accessDenied) {
      saveOutcome("blocked:access_denied");
      return errorResponse(HTTP_STATUS.FORBIDDEN, credentials.resource === "model" ? "Model is not available for this API key" : "No provider account is available for this API key");
    }

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        // Name the local policy that stopped the request. Without this the three
        // very different causes (long breaker, model throttle, locked accounts)
        // collapsed into one opaque bucket and looked like a spring-mouse fault.
        const blockedReason = credentials.breakerOpen
          ? "breaker_open"
          : credentials.modelOverloaded ? "model_overloaded" : "account_locked";
        log.warn("CHAT", `${reqPrefix}[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman}) · ${blockedReason}`);
        saveOutcome(`blocked:${blockedReason}`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `${reqPrefix}No active credentials for provider: ${provider}`);
        saveOutcome("blocked:no_account");
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      // The pool drained, but if every exclusion came from a model-level signal
      // the accounts are still healthy — the MODEL is busy. Lift those
      // exclusions and keep going, bounded by overloadMaxRetries. Without this,
      // three overloads on a three-account channel ended the request as a 503
      // while the configured retry budget was never consulted (measured in
      // production: `No more accounts available` fired, `exceeded channel retry
      // budget` did not). A pool drained by account-level failures stays drained.
      if (modelLevelFailures <= overloadMaxRetries
        && modelLevelExcluded.size === excludeConnectionIds.size
        && modelLevelExcluded.size > 0) {
        log.warn("THROTTLE", `${provider}/${model} | pool drained by model-level signals (${modelLevelFailures}/${overloadMaxRetries}) · retrying accounts`);
        excludeConnectionIds.clear();
        // The refill starts a fresh pass, so the "which exclusions were
        // model-level" tracker must reset with it. Leaving it populated made the
        // size comparison fail on the next drain, so the pool was refilled only
        // once (measured: 3 accounts produced 6 attempts instead of the 9 the
        // budget allows).
        modelLevelExcluded.clear();
        continue;
      }
      // Every account was tried and each attempt failed upstream. Individual
      // attempts are already recorded per account, so the terminal row is
      // attributed to the upstream status it ended on rather than to local policy.
      log.warn("CHAT", `${reqPrefix}No more accounts available`, { provider });
      saveOutcome(lastStatus ? `upstream:${lastStatus}` : "blocked:accounts_exhausted");
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const result = await withRouteLease(credentials.releaseRouteSlot, request?.signal, async () => {
      // Account selection shown in the unified "▶" line (acc:...)
      const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

      // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
      if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
        const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
        if (pid) {
          refreshedCredentials.projectId = pid;
          // Persist to DB in background so subsequent requests have it immediately
          updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
        }
      }

      // Use shared chatCore
      const chatSettings = await getSettings();
      const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
      return await handleChatCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        clientRawRequest,
        requestId,
        // Propagate client disconnects all the way to the upstream executor.
        // Without this, a channel that never responds can retain fetches after
        // the caller has gone away and exhaust the process under concurrency.
        clientSignal: request?.signal,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: !!chatSettings.rtkEnabled,
        headroomEnabled: !!chatSettings.headroomEnabled,
        headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
        headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
        cavemanEnabled: !!chatSettings.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        ponytailEnabled: !!chatSettings.ponytailEnabled,
        ponytailLevel: chatSettings.ponytailLevel || "full",
        pxpipeEnabled: !!chatSettings.pxpipeEnabled,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        // Lazily warms the in-process module on first use; null when not installed (fail-open)
        pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
        onPxpipeEvent: appendPxpipeEvent,
        providerThinking,
        requestLogFileDumpsEnabled: chatSettings.enableRequestLogFileDumps === true,
        requestLogsDir: REQUEST_LOGS_DIR,
        // Request details back the console’s bounded 100-record drawer, so keep
        // capturing them independently of the optional verbose file-dump toggle.
        observabilityEnabled: true,
        observabilityMaxJsonChars: Math.max(1024, Number(chatSettings.observabilityMaxJsonSize || 128) * 1024),
        // Detect source format by endpoint + body
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        // Shared across every model this request tries, so a combo whose members
        // all reach the same saturated upstream cannot multiply the retry budget.
        overloadDeadline,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await Promise.all([
            clearAccountError(credentials.connectionId, credentials, model),
            clearProviderModelBreaker(provider, model),
          ]);
        },
      });

    });
    if (result.success) return result.response;
    if (request?.signal?.aborted || result.status === 499) return errorResponse(499, "Request aborted");

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback, modelLevel, transport } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs, result.upstreamError);

    if (shouldFallback) {
      // Model-level failures (upstream busy) are accounted separately: they must
      // not trip the long provider outage breaker, which is reserved for an
      // upstream that is actually broken rather than merely saturated.
      //
      // A transport failure — we never received an HTTP answer at all (our own
      // network, or a node that never picked the task up) — borrows that same
      // short, model-scoped throttle for the same reason: it is not the
      // account's fault, so it must neither quarantine accounts nor open the
      // long breaker. It deliberately does NOT increment modelLevelFailures,
      // because it says nothing about the model and must not consume the
      // bounded fan-out budget: two dead nodes in front of a healthy account
      // must still rotate to that account.
      //
      // Only upstream-side signals may open a breaker. An account-level failure
      // (bad key, unpaid plan, per-account rate limit) is this account's problem,
      // not the upstream's: recording it here opened the breaker after three
      // accounts *within a single rotation*, which aborted the loop before the
      // healthy accounts further down the list were ever tried — and then cooled
      // the whole channel down for later requests too. The account is already
      // locked for its own cooldown by markAccountUnavailable, so the next account
      // is the correct next step, never the whole channel.
      //
      //   throttled    → model busy / our transport died → short, model-scoped throttle
      //   upstream 5xx → the upstream itself answered with a server error → long breaker
      //   anything else (4xx) → account-scoped → no breaker at all, just rotate
      const throttled = modelLevel || transport;
      const upstreamOutage = !throttled && Number(result.status) >= 500;
      if (throttled || upstreamOutage) {
        const breaker = await recordProviderModelFailure(provider, model, credentials.providerStrategy, { modelLevel: throttled });
        if (breaker.open) {
          const retryAfterMs = breaker.retryAfterMs || 60_000;
          const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
          const human = `retry after ${Math.max(1, Math.round(retryAfterMs / 1000))}s`;
          log.warn(throttled ? "THROTTLE" : "BREAKER", `${provider}/${model} | ${transport ? "transport throttle" : modelLevel ? "model overload throttle" : "opened provider/model breaker"} (${result.status})`);
          saveOutcome(transport ? "blocked:transport" : modelLevel ? "blocked:model_overloaded" : "blocked:breaker_open");
          return unavailableResponse(result.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
            result.error || "Provider model is temporarily unavailable", retryAt, human);
        }
      }

      // A model-level SSE overload means the upstream MODEL is saturated, not this
      // account: every account in the pool reaches the same busy model, so rotating
      // accounts re-runs the executor's whole retry budget against the same
      // saturation — measured at 4 accounts x 90s = 6 minutes for one request, all
      // of it certain to fail. `sse_overload` is set only once the executor has
      // already spent that budget on this model, so hand the failure straight back
      // and let the combo try the next model: that is the only rotation which can
      // actually change the outcome. Account-level failures still rotate as before.
      if (result.upstreamError?.origin === "sse_overload") {
        log.warn("THROTTLE", `${provider}/${model} | SSE overload outlasted the retry budget · not rotating accounts (same upstream model)`);
        saveOutcome(`upstream:${result.status || HTTP_STATUS.SERVICE_UNAVAILABLE}`);
        return result.response;
      }

      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      if (modelLevel) modelLevelExcluded.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;

      if (modelLevel) {
        modelLevelFailures += 1;
        if (modelLevelFailures > overloadMaxRetries) {
          log.warn("THROTTLE", `${provider}/${model} | ${modelLevelFailures} model-level failures exceeded channel retry budget ${overloadMaxRetries}`);
          const retryAt = new Date(Date.now() + MODEL_LEVEL_RETRY_HINT_MS).toISOString();
          saveOutcome(`upstream:${result.status || HTTP_STATUS.SERVICE_UNAVAILABLE}`);
          return unavailableResponse(result.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
            result.error || "Upstream model is busy",
            retryAt, `retry after ${Math.round(MODEL_LEVEL_RETRY_HINT_MS / 1000)}s`);
        }
      }
      continue;
    }

    return result.response;
  }
}
