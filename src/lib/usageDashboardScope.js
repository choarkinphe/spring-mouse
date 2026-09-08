import { getApiKeys, getSettings } from "@/lib/localDb";
import {
  getUsageDashboardScopeApiKeyIds,
  intersectUsageDashboardScope,
} from "@/shared/utils/usageDashboardScope";

/**
 * Applies the persisted usage-dashboard tag scope to an optional API-key drilldown.
 * `apiKeyIds: null` means unrestricted; an empty array means the configured scope
 * currently matches no API keys.
 */
export async function resolveUsageDashboardScope(requestedApiKeyId = null) {
  const [settings, apiKeys] = await Promise.all([getSettings(), getApiKeys()]);
  const scopeTags = settings.usageDashboardScopeTags || [];
  const scopedApiKeyIds = getUsageDashboardScopeApiKeyIds({
    apiKeys,
    apiKeyAccessTags: settings.apiKeyAccessTags || {},
    scopeTags,
  });

  return {
    apiKeyIds: intersectUsageDashboardScope(scopedApiKeyIds, requestedApiKeyId),
    scopeTags,
  };
}
