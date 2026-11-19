/**
 * Claude usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION, CLAUDE_CODE_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";

// Claude API config (urls from registry, apiVersion is header logic kept here)
const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  usageUrl: U("claude").orgUrl,
  settingsUrl: U("claude").settingsUrl,
  apiVersion: ANTHROPIC_API_VERSION,
};

// Limit-reset status is only reported to the Claude Code CLI surface; any
// other user agent answers `ineligible_reason: "surface"`.
const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
const CLAUDE_API_ORIGIN = new URL(CLAUDE_CONFIG.oauthUsageUrl).origin;
const LIMIT_RESET_TIMEOUT_MS = 25000;
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;

// OAuth usage endpoint rate-limits (429); cool down per-token to stop hammering it.
// Only the quota endpoint is affected — chat with the same token still works.
const OAUTH_429_COOLDOWN_MS = 180000;
const oauthCooldown = new Map();

// Dedup + short TTL cache per access token. Many tabs / many accounts / auto-refresh
// all funnel through here; without this each call hits Anthropic and triggers 429.
const USAGE_CACHE_TTL_MS = 300000;
const usageCache = new Map(); // token -> { promise } | { result, expiresAt }

export async function getClaudeUsage(accessToken, proxyOptions = null, options = {}) {
  const force = options?.force === true;

  // Serve in-flight or fresh cached result (skip on manual force)
  if (!force && accessToken) {
    const hit = usageCache.get(accessToken);
    if (hit?.promise) return hit.promise;
    if (hit && hit.expiresAt > Date.now()) return hit.result;
  }

  const stale = (!force && accessToken && usageCache.get(accessToken)?.result) || null;

  const promise = (async () => {
    const result = await fetchClaudeUsageRaw(accessToken, proxyOptions, options?.signal);
    // Only cache real quota data, not soft-failure {message: ...} payloads
    if (accessToken && result?.quotas) {
      usageCache.set(accessToken, {
        result,
        expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
      });
      return result;
    }
    // Soft failure (429/error): prefer the last good read over a transient error
    if (stale) return stale;
    return result;
  })();

  if (accessToken) usageCache.set(accessToken, { promise });
  return promise.finally(() => {
    // A soft failure/abort must not leave a settled promise cached forever.
    // Successful quota reads replace this entry with {result, expiresAt}.
    if (accessToken && usageCache.get(accessToken)?.promise === promise) {
      usageCache.delete(accessToken);
    }
  });
}

/** Drop the cached quota read so the next read reflects a reset. */
export function invalidateClaudeUsage(accessToken) {
  if (accessToken) usageCache.delete(accessToken);
}

async function fetchClaudeUsageRaw(accessToken, proxyOptions = null, signal = undefined) {
  try {
    // Skip OAuth usage call while this token is cooling down from a recent 429
    const cooldownUntil = oauthCooldown.get(accessToken);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return await getClaudeUsageLegacy(accessToken, proxyOptions, signal);
    }

    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    // at_wall=1 also returns both limit-reset programs (grant cards and the
    // weekly session reset) in the same read.
    const oauthResponse = await proxyAwareFetch(`${CLAUDE_CONFIG.oauthUsageUrl}?at_wall=1&skip_spend=1`, {
      method: "GET",
      headers: oauthHeaders(accessToken),
      signal,
    }, proxyOptions);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      // Model-scoped weekly caps (e.g. Fable) now arrive only in `limits[]`,
      // while the legacy seven_day_<model> keys stay null.
      for (const limit of Array.isArray(data.limits) ? data.limits : []) {
        const name = limit?.scope?.model?.display_name || limit?.scope?.model?.id;
        if (limit?.kind !== "weekly_scoped" || typeof name !== "string" || typeof limit.percent !== "number") continue;
        const label = `weekly ${name.toLowerCase()} (7d)`;
        if (!quotas[label]) quotas[label] = createQuotaObject({ utilization: limit.percent, resets_at: limit.resets_at });
      }

      return {
        plan: "Claude Code",
        limitReset: parseLimitResetStatus(data),
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
    }

    // Cool down OAuth usage polling after a 429 (quota endpoint only)
    if (oauthResponse.status === 429) {
      oauthCooldown.set(accessToken, Date.now() + OAUTH_429_COOLDOWN_MS);
    }

    // Fallback: legacy settings + org usage endpoint
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    return await getClaudeUsageLegacy(accessToken, proxyOptions, signal);
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null, signal = undefined) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
      signal,
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
            signal,
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

function oauthHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": CLAUDE_CONFIG.apiVersion,
    "Content-Type": "application/json",
    "User-Agent": CLAUDE_CLI_USER_AGENT,
  };
}

const str = (v) => (typeof v === "string" && v ? v : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * Normalize the two Claude limit-reset programs from /api/oauth/usage:
 *  - cedar_ember: reset grants ("reset cards") with a count of resets left.
 *  - juniper_tide: one session-limit reset per week, usable only at the limit.
 * Returns null when neither block is present.
 */
export function parseLimitResetStatus(data) {
  const cedar = data?.cedar_ember && typeof data.cedar_ember === "object" ? data.cedar_ember : null;
  const tide = data?.juniper_tide && typeof data.juniper_tide === "object" ? data.juniper_tide : null;
  if (!cedar && !tide) return null;
  const grants = (Array.isArray(cedar?.grants) ? cedar.grants : [])
    .filter((g) => g && typeof g.id === "string" && GRANT_ID.test(g.id))
    .map((g) => ({
      id: g.id,
      label: str(g.label) || "",
      resetsLeft: int(g.resets_left) ?? 0,
      resetsTotal: int(g.resets_total) ?? 0,
      endsAt: str(g.ends_at),
      paused: g.paused === true,
      usableNow: g.usable_now === true,
      requiresLimit: g.use_requires_limit !== false,
      unavailableReason: str(g.unavailable_reason),
    }));
  const nextGrantId = str(cedar?.next_grant_id);
  return {
    grants: {
      eligible: cedar?.eligible === true,
      ineligibleReason: str(cedar?.ineligible_reason),
      atLimit: cedar?.at_limit === true,
      cooldownUntil: str(cedar?.cooldown_until),
      nextGrantId: nextGrantId && GRANT_ID.test(nextGrantId) ? nextGrantId : null,
      available: grants.filter((g) => g.resetsLeft > 0 && !g.paused).reduce((n, g) => n + g.resetsLeft, 0),
      items: grants,
    },
    weekly: {
      eligible: tide?.eligible === true,
      ineligibleReason: str(tide?.ineligible_reason),
      available: tide?.available === true,
      nextAvailableAt: str(tide?.next_available_at),
    },
  };
}

/** Read the limit-reset status for one OAuth token (no cache, no side effects). */
export async function getClaudeLimitResetStatus(accessToken, proxyOptions = null) {
  const response = await proxyAwareFetch(`${CLAUDE_CONFIG.oauthUsageUrl}?at_wall=1&skip_spend=1`, {
    method: "GET",
    headers: oauthHeaders(accessToken),
    signal: AbortSignal.timeout(LIMIT_RESET_TIMEOUT_MS),
  }, proxyOptions);
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? "Claude 授权已失效，请重新登录账号"
      : `Claude 用量接口返回 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parseLimitResetStatus(await response.json());
}

async function getOrganizationUuid(accessToken, proxyOptions) {
  const response = await proxyAwareFetch(`${CLAUDE_API_ORIGIN}/api/oauth/profile`, {
    method: "GET",
    headers: oauthHeaders(accessToken),
    signal: AbortSignal.timeout(LIMIT_RESET_TIMEOUT_MS),
  }, proxyOptions);
  if (!response.ok) return null;
  const profile = await response.json().catch(() => null);
  const uuid = profile?.organization?.uuid;
  return typeof uuid === "string" && /^[0-9a-f-]{36}$/i.test(uuid) ? uuid : null;
}

const CLAIM_MESSAGES = {
  reset: "额度已重置",
  already_used: "本周的重置已用过",
  not_limited: "当前未触及用量上限，暂不能重置",
  cooldown: "重置冷却中，请稍后再试",
  ineligible: "此账号没有可用的重置资格",
  unavailable: "Claude 暂时无法重置额度，未消耗重置次数",
  rate_limited: "请求过于频繁，请稍后再试",
  auth_error: "Claude 授权已失效，请重新登录账号",
  error: "重置请求失败，未确认是否已消耗，请刷新额度后查看",
};

/**
 * Claim one Claude limit reset.
 * program "grant" spends one reset card (cedar_ember, needs grantId);
 * program "weekly" uses the weekly session reset (juniper_tide).
 * The server dedupes by request_id, so a caller-supplied id is never reused.
 */
export async function claimClaudeLimitReset(accessToken, { program, grantId = null, requestId, proxyOptions = null }) {
  if (program !== "grant" && program !== "weekly") throw new Error("Unknown Claude reset program");
  if (program === "grant" && (!grantId || !GRANT_ID.test(grantId))) throw new Error("A valid reset grant id is required");
  if (program === "grant" && !/^[A-Za-z0-9_-]{1,64}$/.test(requestId || "")) throw new Error("A valid request id is required");
  const done = (result, extra = {}) => ({ ok: result === "reset", result, message: CLAIM_MESSAGES[result] || CLAIM_MESSAGES.error, ...extra });

  const org = await getOrganizationUuid(accessToken, proxyOptions);
  if (!org) return done("auth_error");
  const body = program === "grant"
    ? { program: "cedar_ember", grant_id: grantId, request_id: requestId }
    : { program: "juniper_tide" };
  let response;
  try {
    response = await proxyAwareFetch(`${CLAUDE_API_ORIGIN}/api/organizations/${org}/reset_rate_limits`, {
      method: "POST",
      headers: oauthHeaders(accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LIMIT_RESET_TIMEOUT_MS),
    }, proxyOptions);
  } catch {
    return done("error");
  }
  if (response.status === 429) return done("rate_limited");
  if (response.status === 401 || response.status === 403) return done("auth_error");
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data.result !== "string") return done("error", { status: response.status });
  const result = CLAIM_MESSAGES[data.result] ? data.result : "unavailable";
  return done(result, {
    resetsLeft: int(data.resets_left),
    cleared: Array.isArray(data.cleared) ? data.cleared.filter((c) => typeof c === "string") : [],
    nextAvailableAt: str(data.next_available_at),
    cooldownUntil: str(data.cooldown_until),
  });
}
