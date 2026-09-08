import { hasAccessTagOverlap, normalizeAccessTags } from "./accessTags";

/**
 * Resolve the API-key IDs included by a usage-dashboard tag scope.
 * An empty tag list intentionally means no restriction (all usage).
 */
export function getUsageDashboardScopeApiKeyIds({ apiKeys = [], apiKeyAccessTags = {}, scopeTags = [] } = {}) {
  const normalizedScopeTags = normalizeAccessTags(scopeTags);
  if (normalizedScopeTags.length === 0) return null;

  return apiKeys
    .filter((apiKey) => apiKey?.id && hasAccessTagOverlap(apiKeyAccessTags?.[apiKey.id], normalizedScopeTags))
    .map((apiKey) => apiKey.id);
}

export function intersectUsageDashboardScope(apiKeyIds, requestedApiKeyId) {
  if (!requestedApiKeyId) return apiKeyIds;
  if (apiKeyIds === null) return [requestedApiKeyId];
  return apiKeyIds.includes(requestedApiKeyId) ? [requestedApiKeyId] : [];
}
