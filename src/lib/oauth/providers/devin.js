import { PROVIDER_OAUTH } from "open-sse/config/providers.js";
import { fetchDevinUserStatus, getDevinIdentity } from "open-sse/services/usage/devin.js";

// Devin's CLI browser login issues a persistent session token, not an expiring
// OAuth access/refresh pair. The executor adds any required wire-format prefix.
export const DEVIN_OAUTH_CONFIG = PROVIDER_OAUTH.devin;

function requestOptions(signal) {
  const timeout = AbortSignal.timeout(30_000);
  return {
    redirect: "error",
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
}

const text = (value) => typeof value === "string" ? value.trim() : "";

export class DevinExchangeError extends Error {
  constructor(reason, status = 502) {
    super(`Devin token exchange failed (${reason}); restart authorization and try again`);
    this.name = "DevinExchangeError";
    this.status = status;
    this.reason = reason;
  }
}

const devin = {
  config: DEVIN_OAUTH_CONFIG,
  flowType: "authorization_code_pkce",
  callbackPath: "/callback",
  buildAuthUrl(config, redirectUri, state, codeChallenge) {
    const url = new URL(config.authorizeUrl);
    if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", config.codeChallengeMethod);
    url.searchParams.set("cli_pkce_marker", "1");
    return url.toString();
  },
  async exchangeToken(config, code, _redirectUri, codeVerifier, _state, options = {}) {
    if (!text(code) || !text(codeVerifier)) throw new Error("Missing Devin authorization code or verifier");
    try {
      const response = await fetch(config.tokenUrl, {
        ...requestOptions(options.signal),
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: text(code), code_verifier: codeVerifier, redirect_uri: _redirectUri || "" }),
      });
      // Surface HTTP status and only known protocol codes, never response text.
      if (!response.ok) {
        let code;
        try { const data = await response.json(); code = data?.code || data?.error?.code; } catch { /* non-JSON failure */ }
        const allowed = ["unauthenticated", "invalid_argument", "permission_denied", "resource_exhausted", "unavailable"];
        throw new DevinExchangeError(`HTTP ${response.status}${allowed.includes(code) ? `, ${code}` : ""}`, response.status);
      }
      let data;
      try { data = await response.json(); } catch { throw new DevinExchangeError("invalid JSON response"); }
      // Devin's session exchange has returned both protobuf-JSON sessionToken
      // and the CLI auth service's token field. Validate the issued credential
      // with GetUserStatus before saving, rather than tying login to one spelling.
      const token = text(data?.sessionToken || data?.session_token || data?.token);
      if (!token || /\s/.test(token)) {
        // Only allowlisted field names/types: never serialize response values or
        // arbitrary keys (an upstream response may contain secrets in either).
        const shape = Object.fromEntries(["sessionToken", "session_token", "token", "data", "result", "error", "code"]
          .filter(key => Object.hasOwn(data || {}, key))
          .map(key => [key, typeof data[key]]));
        console.warn("[Devin OAuth] exchange response shape", JSON.stringify({ endpoint: new URL(config.tokenUrl).pathname, fields: shape }));
        throw new DevinExchangeError("missing or invalid session token");
      }
      console.info(`[Devin OAuth] exchange credential received (${Object.hasOwn(data, "sessionToken") ? "sessionToken" : Object.hasOwn(data, "session_token") ? "session_token" : "token"})`);
      return {
        token,
        devinWebappHost: text(data?.devinWebappHost),
        devinApiUrl: text(data?.devinApiUrl),
      };
    } catch (error) {
      if (error instanceof DevinExchangeError) throw error;
      const reason = ["TimeoutError", "AbortError"].includes(error?.name) ? "timeout or cancellation" : "network request failed";
      throw new DevinExchangeError(reason);
    }
  },
  async postExchange(tokens, options = {}) {
    // GetUserStatus validates the just-issued key and names its account. Devin
    // 401 means this credential is invalid; temporary errors remain best-effort.
    try {
      const status = await fetchDevinUserStatus(tokens.token, options);
      return getDevinIdentity(status);
    } catch (error) {
      if (error?.status === 401) throw new Error("Devin rejected the session token; restart authorization");
      return null;
    }
  },
  mapTokens(tokens, profile) {
    return {
      accessToken: tokens.token,
      ...(profile?.email ? { email: profile.email } : {}),
      ...(profile?.userName ? { displayName: profile.userName } : {}),
      providerSpecificData: {
        authMethod: "oauth",
        ...(profile?.orgId ? { orgId: profile.orgId } : {}),
        ...(profile?.teamId ? { teamId: profile.teamId } : {}),
        // The repository's OAuth dedup key includes username. Bind it to the
        // organization so two orgs under the same email retain separate tokens.
        ...(profile?.orgId || profile?.teamId ? { username: profile.orgId || profile.teamId } : {}),
        ...(profile?.userName ? { userName: profile.userName } : {}),
        ...(profile?.plan ? { plan: profile.plan } : {}),
        ...(tokens.devinWebappHost ? { devinWebappHost: tokens.devinWebappHost } : {}),
        ...(tokens.devinApiUrl ? { devinApiUrl: tokens.devinApiUrl } : {}),
      },
    };
  },
};

export default devin;
