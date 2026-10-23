import { CODEBUDDY_CONFIG } from "../constants/oauth.js";
import { CODEBUDDY_CHECKIN } from "@/shared/config/codebuddyCheckin.js";

// CodeBuddy (Tencent) - Browser OAuth Polling Flow
// 1. POST stateUrl → get { state, authUrl }
// 2. Open authUrl in browser
// 3. Poll tokenUrl with state until success (code 0) or timeout
const codebuddyCn = {
  config: CODEBUDDY_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${config.stateUrl}?platform=workbuddy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CODEBUDDY_CHECKIN.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "copilot.tencent.com",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`CodeBuddy state request failed: ${await response.text()}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
      throw new Error(`CodeBuddy state error: ${data.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: data.data.state,
      verification_uri: data.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      _isCodeBuddy: true,
    };
  },
  pollToken: async (config, deviceCode) => {
    // CodeBuddy polls the token endpoint via GET with the state as a query
    // param (not POST/body) — matches the official CLI's /v2/plugin/auth/token?state=...
    const response = await fetch(`${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": CODEBUDDY_CHECKIN.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "copilot.tencent.com",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = await response.json();
    // code 11217 = pending (RetryFetchToken), code 0 = success
    if (data.code === 0 && data.data?.accessToken) {
      // WorkBuddy daily rewards require the UID from the same authorization
      // state. Do not decode an unverified JWT or query with a fabricated state.
      let uid = null;
      try {
        const accountResponse = await fetch(`${config.baseUrl}/v2/plugin/login/account?state=${encodeURIComponent(deviceCode)}`, {
          headers: {
            Accept: "application/json",
            "User-Agent": CODEBUDDY_CHECKIN.userAgent,
            Authorization: `Bearer ${data.data.accessToken}`,
            "X-Domain": "copilot.tencent.com",
            "X-No-User-Id": "true",
            "X-No-Enterprise-Id": "true",
          },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        const account = accountResponse.ok ? await accountResponse.json() : null;
        if (account?.code === 0 && ["string", "number"].includes(typeof account.data?.uid)) uid = String(account.data.uid);
      } catch { /* Chat authorization can still work without the optional rewards identity. */ }
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
          codebuddy_uid: uid,
        },
      };
    }
    if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in || 86400,
    providerSpecificData: tokens.codebuddy_uid ? { codebuddyUid: tokens.codebuddy_uid } : {},
  }),
};

export default codebuddyCn;
