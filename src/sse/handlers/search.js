import {
  extractApiKey,
  authorizeApiKey,
  resolveApiKeyAccessTags,
} from "../services/auth.js";
import { getSettings, getCombos } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { canAccessWithTags } from "@/shared/utils/accessTags";
import { recordIngressUsage } from "../services/ingressUsage.js";
import { executeGatewaySearchResponse } from "../services/gatewaySearch.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";

/**
 * Handle web search request for the SSE/Next.js server.
 * Provider IS the model (no model field). Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSearch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webSearch)
  const providerInput = body.provider || body.model;
  const query = body.query;

  log.request("POST", `${url.pathname} | ${providerInput}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  const authFailure = await authorizeApiKey(apiKey, { requireApiKey: settings.requireApiKey === true, meter: true, signal: request.signal, model: body.model || body.provider || null });
  if (authFailure) return authFailure;
  const accessTags = await resolveApiKeyAccessTags(apiKey);

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("SEARCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  if (!query || typeof query !== "string" || !query.trim()) {
    log.warn("SEARCH", "Missing query");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }

  await recordIngressUsage(request, apiKey, { model: providerInput });

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos, new Date(), accessTags);
  if (comboModels) {
    const combo = combos.find((item) => item.name === providerInput);
    if (!canAccessWithTags(accessTags, combo?.accessTags)) {
      log.warn("AUTH", `${providerInput} | denied by combo access tags`);
      return errorResponse(HTTP_STATUS.FORBIDDEN, "This model is not available for this API key");
    }
    const comboStrategies = settings.comboStrategies || {};
    const comboConfig = comboStrategies[providerInput] || {};
    const comboStrategy = comboConfig.fallbackStrategy || "fallback";
    const comboStickyLimit = comboConfig.stickyRoundRobinLimit || 1;
    log.info("SEARCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderSearch(b, m, request, apiKey),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderSearch(body, providerInput, request, apiKey);
}

function handleSingleProviderSearch(body, providerInput, request, apiKey) {
  return executeGatewaySearchResponse(body, providerInput, { apiKey, signal: request.signal });
}
