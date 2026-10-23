/**
 * Browser OAuth contract adapted from @magpie-community/opencode-workbuddy-auth
 * 0.1.30, magpie-community/plugins commit 575f1e23e7a3e5f9de45875ed0da94c9289eb982.
 * Copyright (c) 2026 magpie-community contributors. MIT licensed; see the
 * project's third-party notices. No official-client impersonation or prompt
 * rewriting from that implementation is included here.
 */

const SITES = Object.freeze({
  "https://copilot.tencent.com": "workbuddy",
  "https://www.workbuddy.ai": "workbuddy-ai",
});
const SIGN_IN_TTL = 5 * 60 * 1000;
const MAX_PENDING = 128;
const identifier = (value) => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(value) ? value : null;
};
const text = (value, max = 256) => typeof value === "string" && value.trim()
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pending = () => ({ ok: true, data: { error: "authorization_pending" } });
const failed = (error) => ({ ok: false, data: { error } });

function httpsUrl(value) {
  try {
    if (typeof value !== "string" || /[\s\\]/.test(value)) return null;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

function prepareConfig(input) {
  const origin = httpsUrl(input?.origin);
  if (!origin || origin.origin !== input.origin || !SITES[origin.origin]
    || input.platform !== SITES[origin.origin] || input.productId !== SITES[origin.origin]) {
    throw new Error("WorkBuddy OAuth configuration is invalid");
  }
  const config = { ...input };
  for (const key of ["stateUrl", "tokenUrl", "refreshUrl"]) {
    const url = httpsUrl(input[key]);
    if (!url || url.origin !== origin.origin || url.search || url.hash) {
      throw new Error("WorkBuddy OAuth endpoint configuration is invalid");
    }
    config[key] = url.href;
  }
  const hosts = input.authUrlAllowedHosts ?? [];
  if (!Array.isArray(hosts) || hosts.some((host) => {
    const url = httpsUrl(`https://${host}`);
    return typeof host !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)
      || !url || url.hostname !== host || url.pathname !== "/" || url.search || url.hash;
  })) throw new Error("WorkBuddy OAuth login host configuration is invalid");
  config.authUrlAllowedHosts = Object.freeze([...new Set([origin.hostname, ...hosts])]);
  config.pollInterval = Number.isFinite(input.pollInterval) && input.pollInterval > 0 ? input.pollInterval : 2000;
  return Object.freeze(config);
}

function validDomain(value, hostname) {
  // Token metadata is never authority for the next request's destination.
  if (value === undefined || value === "") return hostname;
  if (value !== hostname) throw new Error("invalid_token_domain");
  return hostname;
}

function expiry(data, absolute, relative, now, fallback) {
  if (data[absolute] !== undefined) {
    if (!Number.isSafeInteger(data[absolute]) || data[absolute] <= now) throw new Error("invalid_token_expiry");
    return data[absolute];
  }
  if (data[relative] !== undefined) {
    if (!Number.isFinite(data[relative]) || data[relative] <= 0 || data[relative] > 315360000) {
      throw new Error("invalid_token_expiry");
    }
    return now + data[relative] * 1000;
  }
  return fallback;
}

function readToken(data, hostname) {
  if (!record(data) || !text(data.accessToken, 65536) || /\s/.test(data.accessToken)
    || (data.refreshToken !== undefined && data.refreshToken !== "" && !text(data.refreshToken, 65536))
    || (data.tokenType !== undefined && data.tokenType !== "Bearer")) {
    throw new Error("invalid_token_response");
  }
  const now = Date.now();
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken || "",
    token_type: "Bearer",
    domain: validDomain(data.domain, hostname),
    expires_at: expiry(data, "expiresAt", "expiresIn", now, now + 86400000),
    refresh_expires_at: expiry(data, "refreshExpiresAt", "refreshExpiresIn", now, undefined),
  };
}

/**
 * Create a handler for one trusted site; callers cannot override its origin with
 * device-code extraData, token metadata, or the runtime config argument.
 * authUrlAllowedHosts is an explicit, exact-host allowlist for separate login
 * sites. It does not expand the API origin allowlist.
 */
export function createWorkBuddyOAuthHandler(input) {
  const config = prepareConfig(input);
  const hostname = new URL(config.origin).hostname;
  // In-memory only, bounded, short-lived tokens while /login/account is pending.
  // They must not reach mapTokens/the DB until the same state supplies a UID.
  const waiting = new Map();
  const headers = (noAuth = true) => ({
    Accept: "application/json",
    "User-Agent": "Spring-Mouse/WorkBuddy-OAuth",
    "X-Domain": hostname,
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
    ...(noAuth ? { "X-No-Authorization": "true" } : {}),
  });
  const query = (endpoint, key, value) => {
    const url = new URL(endpoint);
    url.searchParams.set(key, value);
    return url.href;
  };
  async function request(url, options) {
    try {
      const response = await fetch(url, {
        ...options, signal: AbortSignal.timeout(30000), redirect: "error", cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (!record(body) || !Number.isInteger(body.code)) throw new Error();
      return body;
    } catch {
      // Never expose response text, parser diagnostics, URLs/state or tokens.
      throw new Error("request_failed");
    }
  }
  function prune() {
    for (const [state, item] of waiting) {
      if (Date.now() >= item.until || Date.now() >= item.token.expires_at) waiting.delete(state);
    }
  }

  return {
    config,
    flowType: "device_code",
    async requestDeviceCode() {
      const body = await request(query(config.stateUrl, "platform", config.platform), {
        method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: "{}",
      });
      const authUrl = httpsUrl(body.data?.authUrl);
      const state = text(body.data?.state, 4096);
      if (body.code !== 0 || !state || state !== body.data.state || !authUrl
        || !config.authUrlAllowedHosts.includes(authUrl.hostname)) {
        throw new Error("WorkBuddy returned an invalid authorization response");
      }
      return {
        device_code: state, verification_uri: authUrl.href, user_code: "", expires_in: SIGN_IN_TTL / 1000,
        interval: config.pollInterval / 1000, _isCodeBuddy: true, _isWorkBuddy: true,
      };
    },
    async pollToken(_runtimeConfig, state) {
      if (!text(state, 4096) || state !== state.trim()) return failed("invalid_state");
      prune();
      try {
        let item = waiting.get(state);
        if (!item) {
          const body = await request(query(config.tokenUrl, "state", state), { method: "GET", headers: headers() });
          if (body.code === 11217) return pending();
          if (body.code !== 0) return failed("token_request_rejected");
          const token = readToken(body.data, hostname);
          if (waiting.size >= MAX_PENDING) return failed("too_many_pending_authorizations");
          item = { token, until: Date.now() + SIGN_IN_TTL };
          waiting.set(state, item);
        }
        const account = await request(query(`${config.origin}/v2/plugin/login/account`, "state", state), {
          method: "GET", headers: { ...headers(false), Authorization: `Bearer ${item.token.access_token}` },
        });
        if (account.code === 12151) return pending();
        waiting.delete(state);
        if (account.code !== 0) return failed("account_request_rejected");
        const uid = identifier(account.data?.uid);
        if (!uid) return failed("invalid_account_uid");
        if ((account.data.enterpriseId !== undefined && !identifier(account.data.enterpriseId))
          || (account.data.type === "enterprise" && !identifier(account.data.enterpriseId))) {
          return failed("invalid_account_enterprise");
        }
        const email = text(account.data.email, 254);
        return {
          ok: true,
          data: {
            ...item.token,
            expires_in: Math.max(0, Math.floor((item.token.expires_at - Date.now()) / 1000)),
            codebuddy_uid: uid,
            ...(identifier(account.data.enterpriseId) ? { enterprise_id: identifier(account.data.enterpriseId) } : {}),
            ...(text(account.data.nickname) ? { display_name: text(account.data.nickname) } : {}),
            ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {}),
          },
        };
      } catch (error) {
        waiting.delete(state);
        const safe = ["request_failed", "invalid_token_response", "invalid_token_domain", "invalid_token_expiry"];
        return failed(safe.includes(error.message) ? error.message : "invalid_authorization_response");
      }
    },
    mapTokens(tokens) {
      const uid = identifier(tokens?.codebuddy_uid);
      if (!uid || !text(tokens?.access_token, 65536) || /\s/.test(tokens.access_token)) {
        throw new Error("WorkBuddy authorization requires a valid token and account UID");
      }
      const domain = validDomain(tokens.domain, hostname);
      const email = text(tokens.email, 254);
      return {
        accessToken: tokens.access_token,
        refreshToken: text(tokens.refresh_token, 65536) || "",
        expiresIn: Number.isFinite(tokens.expires_at)
          ? Math.max(0, Math.floor((tokens.expires_at - Date.now()) / 1000)) : tokens.expires_in,
        ...(text(tokens.display_name) ? { displayName: text(tokens.display_name) } : {}),
        ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {}),
        providerSpecificData: {
          workbuddyProduct: config.productId,
          workbuddyOrigin: config.origin,
          workbuddyPlatform: config.platform,
          workbuddyContract: "0.1.30",
          codebuddyUid: uid,
          domain,
          tokenType: "Bearer",
          ...(Number.isSafeInteger(tokens.refresh_expires_at) && tokens.refresh_expires_at > 0
            ? { refreshExpiresAt: tokens.refresh_expires_at } : {}),
          ...(identifier(tokens.enterprise_id) ? {
            enterpriseId: identifier(tokens.enterprise_id),
            tenantId: identifier(tokens.enterprise_id),
            tenantVerified: true,
          } : {}),
        },
      };
    },
  };
}
