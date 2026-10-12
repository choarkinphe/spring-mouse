import { randomUUID } from "node:crypto";
import { getSettings } from "@/lib/db/index.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getTrafficRequestId } from "@/lib/networkTraffic.js";
import { getRequestSourceMeta } from "@/shared/utils/requestSource";
import { JEVAPI_CONFIG } from "open-sse/config/jevapi.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { handleSystemoneCore, validateSystemoneRequest } from "open-sse/handlers/systemoneCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { getModelInfo } from "../services/model.js";
import {
  extractApiKey, authorizeApiKey, resolveApiKeyAccessTags,
  getProviderCredentials, markAccountUnavailable, clearAccountError,
} from "../services/auth.js";

export async function handleSystemone(request) {
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const invalid = validateSystemoneRequest(body);
  if (invalid) return errorResponse(HTTP_STATUS.BAD_REQUEST, invalid);
  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  const modelStr = typeof body?.model === "string" && body.model.startsWith("jev-")
    ? `${JEVAPI_CONFIG.provider}/${body.model}` : body?.model;
  const authFailure = await authorizeApiKey(apiKey, {
    requireApiKey: settings.requireApiKey === true, meter: true, signal: request.signal, model: modelStr,
  });
  if (authFailure) return authFailure;

  const { provider, model } = await getModelInfo(modelStr);
  if (provider !== JEVAPI_CONFIG.provider || !model) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Use a ${JEVAPI_CONFIG.provider}/ model with /v1/systemone`);
  }
  const accessTags = await resolveApiKeyAccessTags(apiKey);
  const excludeConnectionIds = new Set();
  let lastResult;
  let connectionId;
  const recordUsage = (status, usage) => {
    const input = usage?.input_tokens;
    const output = usage?.output_tokens;
    const exactUsage = usage?.estimated !== true && Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0;
    saveRequestUsage({
      requestId, startedAt, trafficRequestId: getTrafficRequestId(request),
      provider, model, connectionId, apiKey, endpoint: new URL(request.url).pathname,
      ...getRequestSourceMeta(request),
      tokens: exactUsage ? { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
        : { prompt_tokens: 0, completion_tokens: 0 },
      status,
    }).catch(() => {});
  };

  while (!request.signal.aborted) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { accessTags, requesterId: apiKey || "local" });
    if (credentials?.accessDenied) return errorResponse(HTTP_STATUS.FORBIDDEN, "This model or provider account is not available for this API key");
    if (!credentials || credentials.allRateLimited) {
      recordUsage("error");
      if (lastResult) return lastResult.response;
      if (credentials?.allRateLimited) {
        return unavailableResponse(Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE,
          credentials.lastError || "All JevAPI accounts unavailable", credentials.retryAfter, credentials.retryAfterHuman);
      }
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "No credentials for provider: jevapi");
    }
    connectionId = credentials.connectionId;
    const result = await handleSystemoneCore({ body, modelInfo: { provider, model }, credentials, signal: request.signal });
    if (result.success) {
      await clearAccountError(connectionId, credentials, model);
      recordUsage("success", result.usage);
      return result.response;
    }
    if (result.status === 499) break;
    const { shouldFallback } = await markAccountUnavailable(connectionId, result.status, result.error, provider, model, result.resetsAtMs, result.upstreamError);
    if (!shouldFallback) {
      recordUsage("error");
      return result.response;
    }
    excludeConnectionIds.add(connectionId);
    lastResult = result;
  }
  recordUsage("error");
  return errorResponse(499, "Request aborted");
}
