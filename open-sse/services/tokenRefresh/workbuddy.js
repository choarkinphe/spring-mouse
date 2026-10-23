// WorkBuddy refresh contract adapted from magpie-community/plugins@575f1e23
// packages/workbuddy (MIT); see THIRD_PARTY_NOTICES.md.
import { resolveWorkBuddySite, buildWorkBuddyHeaders } from "../../config/workbuddy.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "./dedup.js";
import { refreshCodebuddyToken, refreshCodebuddyIntlToken } from "./providers.js";

// Migrated CodeBuddy credentials delegate to the exact refresh implementation
// they used before the rename. This keeps production accounts working without a
// re-login: the request host, headers and response parser are unchanged.
function refreshLegacyCodeBuddyToken(provider, credentials, log) {
  return provider === "workbuddy"
    ? refreshCodebuddyToken(credentials.refreshToken, log)
    : refreshCodebuddyIntlToken(credentials.refreshToken, log);
}

function expiry(data, absolute, relative, now, fallback) {
  if (data[relative] !== undefined && (typeof data[relative] !== "number" || !Number.isFinite(data[relative]) || data[relative] <= 0)) {
    throw new Error("Invalid WorkBuddy token expiry");
  }
  const value = data[absolute] !== undefined ? data[absolute]
    : data[relative] !== undefined ? now + data[relative] * 1000 : fallback;
  if (!Number.isSafeInteger(value) || value <= now) throw new Error("Invalid WorkBuddy token expiry");
  return value;
}

export async function refreshWorkBuddyToken(provider, credentials, log, proxyOptions = null) {
  if (!credentials?.refreshToken) return null;
  const metadata = credentials.providerSpecificData || {};
  // A migrated CodeBuddy credential keeps the refresh call it was already using,
  // byte for byte: same host, same headers, same parser. The new WorkBuddy
  // contract only applies to authorizations this build issued.
  if (metadata.workbuddyLegacyCredential === true) {
    return refreshLegacyCodeBuddyToken(provider, credentials, log);
  }
  const site = resolveWorkBuddySite(provider, metadata);
  // Validate provenance before sending any rotating credential.
  const headers = buildWorkBuddyHeaders(provider, credentials);
  if (metadata.refreshExpiresAt && metadata.refreshExpiresAt <= Date.now()) return { error: "invalid_grant" };
  return dedupRefresh(provider, credentials.refreshToken, async signal => {
    try {
      delete headers.Authorization;
      const response = await proxyAwareFetch(`${site.origin}/v2/plugin/auth/token/refresh`, {
        method: "POST", headers: { ...headers, "X-Refresh-Token": credentials.refreshToken, "X-Auth-Refresh-Source": "plugin" },
        body: "{}", signal, redirect: "error",
      }, proxyOptions);
      if (!response.ok) return response.status === 401 || response.status === 403 ? { error: "invalid_grant" } : null;
      const result = await response.json();
      const data = result?.data;
      if (result?.code !== 0 || !data || typeof data.accessToken !== "string" || !data.accessToken || /[\s\x00-\x1f\x7f]/.test(data.accessToken)) return null;
      if (data.domain !== undefined && data.domain !== site.domain) return null;
      if (data.tokenType !== undefined && data.tokenType !== "Bearer") return null;
      if (data.refreshToken !== undefined && (typeof data.refreshToken !== "string" || /[\s\x00-\x1f\x7f]/.test(data.refreshToken))) return null;
      const now = Date.now();
      const expiresAt = expiry(data, "expiresAt", "expiresIn", now, now + 86400000);
      const refreshExpiresAt = data.refreshExpiresAt !== undefined || data.refreshExpiresIn !== undefined
        ? expiry(data, "refreshExpiresAt", "refreshExpiresIn", now) : metadata.refreshExpiresAt;
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || credentials.refreshToken,
        expiresIn: Math.floor((expiresAt - now) / 1000),
        providerSpecificData: { ...metadata, tokenType: "Bearer", domain: site.domain,
          ...(refreshExpiresAt ? { refreshExpiresAt } : {}) },
      };
    } catch {
      log?.warn?.("TOKEN_REFRESH", `${provider} refresh failed`);
      return null;
    }
  }, log);
}
