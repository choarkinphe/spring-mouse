import { createHash } from "node:crypto";
import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { getTargetFormat } from "open-sse/services/provider.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { CAPABILITY_PROBE_VERSION, CAPABILITY_EVIDENCE_TTL_MS } from "@/shared/constants/capabilityTests.js";

export function capabilityFingerprint(connection, modelId) {
  const provider = connection.provider;
  const data = connection.providerSpecificData || {};
  // OAuth access/refresh tokens rotate without changing the tested account. API keys
  // and stable identity/endpoint settings do change the tested path.
  const identity = {
    provider, connectionId: connection.id, modelId,
    upstreamModel: getModelUpstreamId(PROVIDER_ID_TO_ALIAS[provider] || provider, modelId),
    format: getTargetFormat(provider, connection),
    projectId: connection.projectId || data.projectId || null,
    authType: connection.authType || null,
    region: data.region || connection.region || null,
    transport: PROVIDERS[provider]?.transport,
    endpoint: PROVIDERS[provider]?.baseUrl || PROVIDERS[provider]?.baseUrls || null,
    apiKey: connection.apiKey || null,
    email: connection.email || null,
    accountId: data.accountId || data.userId || null,
    baseUrl: data.baseUrl || null, apiType: data.apiType || null,
    mouseId: connection.mouseId || null,
    stableCredential: !connection.apiKey && !connection.refreshToken && !connection.email && !data.accountId && !data.userId ? connection.accessToken || null : null,
    proxy: [data.connectionProxyEnabled, data.connectionProxyUrl, data.connectionNoProxy],
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function currentEvidence(profile, fingerprint, now = Date.now()) {
  if (!profile || profile.fingerprint !== fingerprint) return {};
  return Object.fromEntries(Object.entries(profile.evidence || {}).filter(([, result]) =>
    result.fingerprint === fingerprint && result.probeVersion === CAPABILITY_PROBE_VERSION
    && Number.isFinite(Date.parse(result.testedAt)) && now - Date.parse(result.testedAt) < CAPABILITY_EVIDENCE_TTL_MS));
}

export function evidenceCapabilities(evidence) {
  const caps = {};
  for (const [key, result] of Object.entries(evidence || {})) {
    if (["text", "structuredOutput", "contextWindow"].includes(key)) continue;
    if (result.status === "supported") caps[key] = true;
    if (result.status === "unsupported") caps[key] = false;
  }
  // Only an explicit upstream total-context limit can replace contextWindow.
  const context = evidence?.contextWindow?.context;
  if (context?.limitKind === "total" && Number.isInteger(context.explicitLimit) && context.explicitLimit > 0) caps.contextWindow = context.explicitLimit;
  return caps;
}

export function manualCapabilities(model) {
  if (model?.manualCapabilities) return model.manualCapabilities;
  if (model?.origin === "capability-override" || (model?.capabilities && !model.source)) return model.capabilities || {};
  return {};
}
