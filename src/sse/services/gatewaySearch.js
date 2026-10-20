import { getProviderCredentials, markAccountUnavailable, clearAccountError, resolveApiKeyAccessTags } from "./auth.js";
import { checkAndRefreshToken } from "./tokenRefresh.js";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleSearchCore } from "open-sse/handlers/search/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { runWithAbortDeadline } from "open-sse/utils/abortable.js";
import * as log from "../utils/logger.js";

const SEARCH_TIMEOUT_MS = 15000;
const MAX_ACCOUNT_ATTEMPTS = 3;

/** Shared provider execution; no ingress authorization or usage metering here. */
export async function executeGatewaySearchResponse(body, provider, {
  apiKey, accessTags, signal, deadlineMs, dedicatedOnly = false,
} = {}) {
  const controller = new AbortController();
  const effectiveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = Math.min(
    Date.now() + SEARCH_TIMEOUT_MS,
    Number.isFinite(deadlineMs) ? deadlineMs : Infinity,
  );
  if (signal?.aborted) return errorResponse(499, "Search cancelled");
  if (deadline <= Date.now()) return errorResponse(504, "Search deadline exceeded");
  try {
    return await runWithAbortDeadline(async () => {
      const tags = Array.isArray(accessTags) ? accessTags : await resolveApiKeyAccessTags(apiKey);
      effectiveSignal.throwIfAborted();
      return executeProviderSearch(body, provider, {
        apiKey, accessTags: tags, signal: effectiveSignal, deadlineMs: deadline, dedicatedOnly,
      });
    }, {
      signal: effectiveSignal,
      timeoutMs: Math.max(1, deadline - Date.now()),
      onTimeout: () => controller.abort(),
    });
  } catch {
    return errorResponse(signal?.aborted ? 499 : controller.signal.aborted ? 504 : 502,
      signal?.aborted ? "Search cancelled" : controller.signal.aborted ? "Search deadline exceeded" : "Search failed");
  } finally {
    controller.abort();
  }
}

/**
 * Internal search for already-authorized callers. deadlineMs is an absolute epoch
 * timestamp. Uses configured dedicated APIs only, never a model/combo or URL override.
 * apiKey identifies the gateway caller, not the upstream credential.
 */
export async function runGatewaySearch({ provider, query, maxResults, apiKey, accessTags, signal, deadlineMs } = {}) {
  if (typeof provider !== "string" || !provider.trim() || typeof query !== "string" || !query.trim()
      || (maxResults != null && (!Number.isInteger(maxResults) || maxResults < 1))) {
    throw gatewaySearchError(400);
  }
  const response = await executeGatewaySearchResponse({ query, max_results: maxResults }, provider, {
    apiKey, accessTags, signal, deadlineMs, dedicatedOnly: true,
  });
  if (!response.ok) throw gatewaySearchError(response.status);
  return response.json();
}

function gatewaySearchError(status) {
  const error = new Error(status === 499 ? "Search cancelled" : status === 504 ? "Search deadline exceeded" : "Gateway search failed");
  error.name = "GatewaySearchError";
  error.status = status;
  return error;
}

async function executeProviderSearch(body, providerInput, { apiKey, accessTags, signal, deadlineMs, dedicatedOnly }) {
  const query = body.query;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("SEARCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.searchConfig;
  const supportsSearch = !!providerConfig || (!dedicatedOnly && !!resolvedProvider.searchViaChat);

  if (!supportsSearch) {
    log.warn("SEARCH", "Provider does not support web search", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web search`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // Sanitized body forwarded to core
  const coreBody = {
    query: query.trim(),
    provider: providerId,
    max_results: body.max_results,
    search_type: body.search_type,
    country: body.country,
    language: body.language,
    time_range: body.time_range,
    offset: body.offset,
    domain_filter: body.domain_filter,
    content_options: body.content_options,
    provider_options: body.provider_options
  };

  // No-auth providers (e.g. searxng) bypass credential lookup
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleSearchCore({
      body: coreBody,
      provider: dedicatedOnly ? { ...resolvedProvider, searchViaChat: undefined } : resolvedProvider,
      providerConfig,
      credentials: null,
      signal,
      log: dedicatedOnly ? undefined : log
    });
    return result.response;
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    const credentials = await getProviderCredentials(providerId, excludeConnectionIds, null, {
      accessTags, requesterId: apiKey || "local", reserveSlot: false, signal, deadlineMs,
    });
    signal.throwIfAborted();

    if (credentials?.accessDenied) return errorResponse(HTTP_STATUS.FORBIDDEN, "This provider account is not available for this API key");
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("SEARCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${providerId}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
      }
      log.warn("SEARCH", "No more accounts available", { provider: providerId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

    signal.throwIfAborted();
    const result = await handleSearchCore({
      body: coreBody,
      provider: dedicatedOnly ? { ...resolvedProvider, searchViaChat: undefined } : resolvedProvider,
      providerConfig,
      credentials: refreshedCredentials,
      signal,
      // Internal errors/logs never include upstream payloads or credential-bearing URLs.
      log: dedicatedOnly ? undefined : log
    });

    signal.throwIfAborted();
    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials);
      return result.response;
    }
    // A cancelled request must not poison account health or start a fallback.
    if (result.status === 499) return result.response;

    const safeError = dedicatedOnly ? `Search upstream failed (${result.status})` : result.error;
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, safeError, providerId);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = safeError;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
  return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "Search account attempt limit reached");
}
