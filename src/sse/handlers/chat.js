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
import { getModelInfo, getComboModelEntries } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities, getComboModelsForRequest, getUnsupportedComboRequestCapability } from "open-sse/services/combo.js";
import { classifyAutoRequest, normalizeAutoRoutingConfig, reorderByAutoLevel } from "open-sse/services/autoRouting.js";
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
import { createRoutingTelemetrySession, attemptTerminalFromResult } from "../services/routingTelemetry.js";
import { createRoutingObserver } from "open-sse/utils/routingOutcome.js";

function resolveComboRequestModels(comboModels, requiredCapabilities, capabilities) {
  const unsupported = getUnsupportedComboRequestCapability(requiredCapabilities, capabilities);
  if (unsupported) return { error: `Combo does not declare ${unsupported} input support` };

  const models = getComboModelsForRequest(comboModels, requiredCapabilities, capabilities);
  if (models.length === 0) return { error: "No active combo model can handle this request's declared inputs" };
  return { models };
}

function resolveComboRoutingModels(entries, requiredCapabilities, capabilities) {
  const nodes = Array.isArray(entries) ? entries : [];
  const resolved = resolveComboRequestModels(nodes.map((entry) => typeof entry === "string" ? entry : entry.model), requiredCapabilities, capabilities);
  if (resolved.error) return resolved;
  const byModel = new Map(nodes.map((entry) => [typeof entry === "string" ? entry : entry.model, entry]));
  return { models: resolved.models.map((model) => byModel.get(model) || model) };
}

function withOriginalModelContext(clientRawRequest, originalModel) {
  if (!clientRawRequest || !originalModel) return clientRawRequest;
  const rawBody = clientRawRequest.body && typeof clientRawRequest.body === "object" ? clientRawRequest.body : {};
  return rawBody.model === originalModel
    ? clientRawRequest
    : { ...clientRawRequest, body: { ...rawBody, model: originalModel } };
}

async function applyAutoRouting({ body, entries, comboConfig, comboName, requiredCapabilities, request, apiKey, accessTags, overloadDeadline, log, clientRawRequest = null, autoRoutingDepth = 0, routing = null }) {
  const config = normalizeAutoRoutingConfig(comboConfig?.autoRouting);
  const classifierConfig = autoRoutingDepth >= 2 || config.classifierModel === comboName
    ? { ...config, classifierModel: "" }
    : config;
  const classification = await classifyAutoRequest({
    body,
    config: classifierConfig,
    requiredCapabilities,
    signal: request?.signal,
    log,
    callModel: (classifierBody, classifierModel, classifierSignal) => handleSingleModelChat(
      classifierBody,
      classifierModel,
      withOriginalModelContext(clientRawRequest, comboName),
      request,
      apiKey,
      accessTags,
      Math.min(overloadDeadline || Infinity, Date.now() + classifierConfig.classifierTimeoutMs),
      { internalRequest: true, clientSignal: classifierSignal, autoRoutingDepth: autoRoutingDepth + 1, routing, role: "classifier" },
    ),
  });
  const routed = reorderByAutoLevel(entries, classification.level, config.levelOrder);
  routing?.hint({ autoSource: classification.source, autoLevel: classification.level, autoConfidence: classification.confidence });
  log.info("AUTO", `Combo auto level=${classification.level} source=${classification.source} · first=${routed[0]?.model || routed[0] || "none"}`);
  return routed;
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
  // The session is created at the external entry point, before parsing/auth or
  // bypass checks, so every client request has one stable routing id.
  const routing = createRoutingTelemetrySession({
    endpoint: clientRawRequest?.endpoint || (() => { try { return new URL(request.url).pathname; } catch { return null; } })(),
    trafficRequestId: getTrafficRequestId(request),
  });
  routing.open({ endpoint: clientRawRequest?.endpoint, trafficRequestId: getTrafficRequestId(request) });
  const finishEarly = (response, terminalReason) => {
    routing.setTerminalReason(terminalReason);
    routing.completeFromResponse(response, terminalReason);
    return response;
  };

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      log.warn("CHAT", "Invalid JSON body");
      return finishEarly(errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body"), "invalid_json");
    }

    // Build clientRawRequest for logging (if not provided).
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
    const modelStr = body?.model;
    routing.hint({
      originalModel: modelStr,
      endpoint: clientRawRequest?.endpoint,
      trafficRequestId: getTrafficRequestId(request),
      requestType: Array.isArray(body?.tools) && body.tools.length > 0 ? "tool" : "chat",
    });

    const authHeader = request.headers.get("Authorization");
    const apiKey = extractApiKey(request);
    if (authHeader && apiKey) log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
    else log.debug("AUTH", "No API key provided (local mode)");

    const settings = await getSettings();
    const authFailure = await authorizeApiKey(apiKey, {
      requireApiKey: settings.requireApiKey === true,
      meter: true,
      signal: request.signal,
      model: modelStr,
    });
    if (authFailure) return finishEarly(authFailure, "auth_rejected");
    const accessTags = await resolveApiKeyAccessTags(apiKey);

    if (!modelStr) {
      log.warn("CHAT", "Missing model");
      return finishEarly(errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model"), "missing_model");
    }

    await refreshModelCapabilityOverrides().catch((error) => {
      log.warn("CAPABILITIES", `Failed to load synchronized model capabilities: ${error.message}`);
    });

    const userAgent = request?.headers?.get("user-agent") || "";
    const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
    if (bypassResponse) return finishEarly(bypassResponse.response || bypassResponse, "bypass");

    const requiredCapabilities = detectRequiredCapabilities(body);
    const overloadDeadline = Date.now() + REQUEST_OVERLOAD_BUDGET_MS;
    const comboEntries = await getComboModelEntries(modelStr, accessTags);
    let response;

    if (comboEntries) {
      const combo = await getComboByName(modelStr);
      if (!canAccessWithTags(accessTags, combo?.accessTags)) {
        log.warn("AUTH", `${modelStr} | denied by combo access tags`);
        return finishEarly(errorResponse(HTTP_STATUS.FORBIDDEN, "This model is not available for this API key"), "access_denied");
      }
      const resolved = resolveComboRoutingModels(comboEntries, requiredCapabilities, combo?.capabilities);
      if (resolved.error) return finishEarly(errorResponse(HTTP_STATUS.BAD_REQUEST, resolved.error), "unsupported_capability");

      const comboStrategies = settings.comboStrategies || {};
      const comboConfig = comboStrategies[modelStr] || {};
      const comboStrategy = comboConfig.fallbackStrategy || "fallback";
      routing.hint({ strategy: comboStrategy, comboName: modelStr });
      const routedEntries = comboStrategy === "auto"
        ? await applyAutoRouting({ body, entries: resolved.models, comboConfig, comboName: modelStr, requiredCapabilities, request, overloadDeadline, log, clientRawRequest, routing })
        : resolved.models;
      const routedModels = routedEntries.map((entry) => typeof entry === "string" ? entry : entry.model);

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo \"${modelStr}\" with ${routedModels.length} compatible models (strategy: fusion)`);
        response = await handleFusionChat({
          body,
          models: routedModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, accessTags, overloadDeadline, {
              routing,
              role: isPanel ? "panel" : "judge",
            });
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      } else {
        const comboStickyLimit = comboConfig.stickyRoundRobinLimit || 1;
        log.info("CHAT", `Combo \"${modelStr}\" with ${routedModels.length} compatible models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
        response = await handleComboChat({
          body,
          models: routedModels,
          handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, accessTags, overloadDeadline, { routing, role: "primary" }),
          log,
          comboName: modelStr,
          comboStrategy,
          comboStickyLimit,
        });
      }
    } else {
      response = await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, accessTags, overloadDeadline, { routing, role: "primary" });
    }

    // Select only the response returned by the complete external route. A failed
    // account/model fallback is never allowed to settle the parent prematurely.
    routing.finalize(response);
    return response;
  } catch (error) {
    routing.complete({
      outcome: request?.signal?.aborted ? "cancelled" : "failed",
      terminalReason: request?.signal?.aborted ? "client_abort" : "internal_error",
    });
    throw error;
  }
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, accessTags = [], overloadDeadline = null, { internalRequest = false, clientSignal = null, autoRoutingDepth = 0, routing = null, role = "primary" } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  const requestStartTime = Date.now();
  // One id for this client request, shared by the routing log lines, the usage
  // row, and every retry inside the loop below. chatCore used to mint its own id
  // that never reached a log line, so a specific failure could not be tied back
  // to the account/lock/breaker events it caused.
  const requestId = randomUUID();
  const reqPrefix = `[${requestId.slice(0, 8)}] `;
  const modelCallId = requestId;
  const attemptRole = role;

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
    if (!request || internalRequest) return;
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
      originalModel: clientRawRequest?.body?.model || body?.model || modelStr || null,
      executedModel: modelInfo.provider && modelInfo.model
        ? `${modelInfo.provider}/${modelInfo.model}`
        : modelInfo.model || null,
      routing: {
        originalModel: clientRawRequest?.body?.model || body?.model || modelStr || null,
        executedModel: modelInfo.provider && modelInfo.model
          ? `${modelInfo.provider}/${modelInfo.model}`
          : modelInfo.model || null,
      },
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
    const comboEntries = await getComboModelEntries(modelStr, accessTags);
    if (comboEntries) {
      const combo = await getComboByName(modelStr);
      if (!canAccessWithTags(accessTags, combo?.accessTags)) {
        log.warn("AUTH", `${modelStr} | denied by combo access tags`);
        return errorResponse(HTTP_STATUS.FORBIDDEN, "This model is not available for this API key");
      }
      const chatSettings = await getSettings();
      const requiredCapabilities = detectRequiredCapabilities(body);
      const resolved = resolveComboRoutingModels(comboEntries, requiredCapabilities, combo?.capabilities);
      if (resolved.error) {
        const response = errorResponse(HTTP_STATUS.BAD_REQUEST, resolved.error);
        routing?.complete({ outcome: "failed", terminalReason: "unsupported_capability" });
        return response;
      }

      const comboStrategies = chatSettings.comboStrategies || {};
      const comboConfig = comboStrategies[modelStr] || {};
      const comboStrategy = comboConfig.fallbackStrategy || "fallback";
      const routedEntries = comboStrategy === "auto"
        ? await applyAutoRouting({ body, entries: resolved.models, comboConfig, comboName: modelStr, requiredCapabilities, request, overloadDeadline, log, clientRawRequest, autoRoutingDepth, routing })
        : resolved.models;
      const routedModels = routedEntries.map((entry) => typeof entry === "string" ? entry : entry.model);

      if (comboStrategy === "fusion") {
        routing?.hint({ strategy: "fusion", comboName: modelStr });
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
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, accessTags, overloadDeadline, {
              routing,
              role: isPanel ? "panel" : "judge",
            });
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
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, accessTags, overloadDeadline, { routing, role: "primary" }),
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
  const openAttempt = (credentials) => {
    const attempt = routing?.openAttempt({
      modelCallId, role: attemptRole, provider, model,
      connectionId: credentials?.connectionId, streamMode: body?.stream === false ? "nonstream" : "stream",
      internal: internalRequest,
    }) || { id: null, observer: null, complete() {}, bindResponse() {}, isSettled: () => true };
    // The session's observer exposes only the raw protocol callbacks (onHeaders/
    // onTerminal/...). The chatCore response paths drive the OTHER interface —
    // emitHeaders()/settle()/noteFirstToken()/recordTerminal() — which lives on
    // this fail-open wrapper. Passing the raw observer straight through made
    // `routingObserver.emitHeaders(...)` throw `is not a function` on the FIRST
    // streaming (and non-streaming, and SSE→JSON) response, before a single byte
    // reached the client: a 500 on every chat request. The wrapper also makes the
    // observer fail-open, which the raw object is not.
    if (attempt.observer) {
      attempt.observer = createRoutingObserver({ observer: attempt.observer, requestStartTime }) || attempt.observer;
    }
    return attempt;
  };
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
    if (clientSignal?.aborted || request?.signal?.aborted) return errorResponse(499, "Request aborted");
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
        accessTags, requesterId: apiKey || "local", reserveSlot: true, body, signal: clientSignal || request?.signal, requestId,
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

    if (clientSignal?.aborted || request?.signal?.aborted) return errorResponse(499, "Request aborted");
    const attempt = openAttempt(credentials);
    const result = await withRouteLease(credentials.releaseRouteSlot, clientSignal || request?.signal, async () => {
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
        routingObserver: attempt.observer,
        // Propagate client disconnects all the way to the upstream executor.
        // Without this, a channel that never responds can retain fetches after
        // the caller has gone away and exhaust the process under concurrency.
        clientSignal: clientSignal || request?.signal,
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
        observabilityEnabled: !internalRequest,
        observabilityMaxJsonChars: Math.max(1024, Number(chatSettings.observabilityMaxJsonSize || 128) * 1024),
        internalRequest,
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
    attempt.bindResponse(result.response);
    if (result.success) {
      // A streaming result is a LAZY body: nothing has been read yet, so its
      // ttft/duration/usage do not exist and `attemptTerminalFromResult` would
      // latch durationMs=0, ttftMs=0 and null tokens — permanently, because the
      // session's complete() is first-wins. The stream pipeline settles the
      // attempt itself, once the stream actually terminates and it has the real
      // numbers (open-sse/utils/stream.js settleObserver). Non-streaming results
      // are already fully read, so they settle here as before.
      if (!result.streaming) attempt.complete(attemptTerminalFromResult(result));
      return result.response;
    }
    if (request?.signal?.aborted || result.status === 499) {
      attempt.complete({ outcome: "cancelled", terminalReason: "client_abort", upstreamStatus: 499 });
      return errorResponse(499, "Request aborted");
    }

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
          // usageHistory.status is the operator- and dashboard-facing record of WHY a
          // request stopped, and these two lines are its only writer on this path.
          // Routing telemetry (attempt.complete) records the same event into a
          // DIFFERENT table and is not a substitute: dropping these left the failure
          // invisible in the usage views while the request still 503'd.
          log.warn(throttled ? "THROTTLE" : "BREAKER", `${provider}/${model} | ${transport ? "transport throttle" : modelLevel ? "model overload throttle" : "opened provider/model breaker"} (${result.status})`);
          saveOutcome(transport ? "blocked:transport" : modelLevel ? "blocked:model_overloaded" : "blocked:breaker_open");
          attempt.complete({ outcome: "failed", terminalReason: transport ? "transport_error" : modelLevel ? "model_overloaded" : "breaker_open", upstreamStatus: result.status, fallbackReason: "account_fallback" });
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
        attempt.complete({ outcome: "failed", terminalReason: "model_overloaded", upstreamStatus: result.status, fallbackReason: "model_fallback" });
        return result.response;
      }

      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      attempt.complete({ outcome: "failed", terminalReason: "account_fallback", upstreamStatus: result.status, fallbackReason: "account_fallback" });
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
          attempt.complete({ outcome: "failed", terminalReason: "model_overloaded", upstreamStatus: result.status, fallbackReason: "model_fallback" });
          return unavailableResponse(result.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
            result.error || "Upstream model is busy",
            retryAt, `retry after ${Math.round(MODEL_LEVEL_RETRY_HINT_MS / 1000)}s`);
        }
      }
      continue;
    }

    attempt.complete(attemptTerminalFromResult(result, { fallbackReason: "upstream_http_error" }));
    return result.response;
  }
}
