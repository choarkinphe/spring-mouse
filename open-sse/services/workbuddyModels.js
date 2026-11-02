// Account catalog contract adapted from @magpie-community/opencode-workbuddy-auth
// 0.1.30 (MIT); see THIRD_PARTY_NOTICES.md.
import { buildWorkBuddyHeaders, getWorkBuddySite } from "../config/workbuddy.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export function parseWorkBuddyModels(payload) {
  if (payload?.code !== 0 || !Array.isArray(payload.data?.agents) || !Array.isArray(payload.data?.models)) {
    throw new Error("Invalid WorkBuddy account catalog");
  }
  const agent = payload.data.agents.find(agent => agent?.name === "cli");
  if (!Array.isArray(agent?.models)) throw new Error("WorkBuddy CLI catalog is missing");
  const known = new Map(payload.data.models.filter(model => typeof model?.id === "string" && model.id.trim()).map(model => [model.id, model]));
  const ids = [...new Set(agent.models.map(item => typeof item === "string" ? item : item?.id))];
  return ids.map(id => {
    const model = known.get(id);
    if (!model) throw new Error("Incomplete WorkBuddy account catalog");
    return {
      id: model.id, name: typeof model.name === "string" ? model.name : model.id,
      supportedFormats: ["openai"],
      ...(Number.isSafeInteger(model.maxInputTokens) && model.maxInputTokens > 0 ? { contextWindow: model.maxInputTokens } : {}),
      ...(Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0 ? { maxOutputTokens: model.maxOutputTokens } : {}),
      capabilities: { ...(typeof model.supportsImages === "boolean" ? { vision: model.supportsImages } : {}),
        ...(typeof model.supportsReasoning === "boolean" ? { reasoning: model.supportsReasoning } : {}) },
    };
  });
}

export async function discoverWorkBuddyModels(connection, proxyOptions = null) {
  const site = getWorkBuddySite(connection.provider);
  const response = await proxyAwareFetch(`${site.origin}/v3/config`, {
    method: "GET", headers: buildWorkBuddyHeaders(connection.provider, connection),
    signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error",
  }, proxyOptions);
  if (!response.ok) return { error: `WorkBuddy model discovery returned HTTP ${response.status}`, status: response.status };
  return { models: parseWorkBuddyModels(await response.json()), listingScope: "account" };
}
