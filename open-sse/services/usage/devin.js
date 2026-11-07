// Contract pinned to magpie-community/plugins 749e9dd12a5401cc11a701b7598c7ce32fcd7259,
// packages/devin/index.mjs userStatus, whoOfStatus and usage (MIT).
import { PROVIDER_OAUTH } from "../../config/providers.js";
import { DEVIN } from "../../config/devin.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { normalizeDevinSessionToken } from "../../shared/devin/protocol.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

function statusError(status) {
  const error = new Error(status === 401
    ? "Devin authentication expired; sign in again"
    : "Devin account status is temporarily unavailable");
  error.status = status;
  return error;
}

export async function fetchDevinUserStatus(credentials, { proxyOptions, fetchFn = proxyAwareFetch, signal } = {}) {
  const raw = typeof credentials === "string" ? credentials : credentials?.accessToken;
  const token = normalizeDevinSessionToken(raw);
  if (!token) throw statusError(401);
  const timeout = AbortSignal.timeout(15_000);
  try {
    const res = await fetchFn(PROVIDER_OAUTH.devin.profileUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: JSON.stringify({ metadata: {
        ideName: "devin-cli", ideVersion: DEVIN.clientVersion,
        extensionName: "devin-cli", extensionVersion: DEVIN.clientVersion,
        apiKey: token, locale: DEVIN.locale,
        os: process.platform === "win32" ? "windows" : process.platform,
      } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error", cache: "no-store",
    }, proxyOptions);
    if (res.status === 401) throw statusError(401);
    let data;
    try { data = await res.json(); } catch { throw statusError(res.ok ? 502 : res.status); }
    const code = data?.error?.code || data?.code;
    if (code === "unauthenticated") throw statusError(401);
    if (!res.ok || code) {
      const known = ["unauthenticated", "invalid_argument", "permission_denied", "resource_exhausted", "unavailable", "unimplemented"];
      console.warn("[Devin status] upstream rejection", JSON.stringify({ status: res.status, code: known.includes(code) ? code : undefined }));
      throw statusError(res.ok ? 502 : res.status);
    }
    if (!data?.userStatus || typeof data.userStatus !== "object" || Array.isArray(data.userStatus)) {
      const fields = Object.fromEntries(["userStatus", "user_status", "status", "data", "result", "error", "code"].filter(key => Object.hasOwn(data || {}, key)).map(key => [key, typeof data[key]]));
      console.warn("[Devin status] unexpected response shape", JSON.stringify({ status: res.status, fields }));
      throw statusError(502);
    }
    return data.userStatus;
  } catch (error) {
    // No response text or transport error may echo a session token.
    if (error?.status) throw statusError(error.status);
    throw statusError(502);
  }
}

export function getDevinIdentity(userStatus = {}) {
  const clean = value => typeof value === "string" ? value.trim() : "";
  const info = userStatus.planStatus?.planInfo || {};
  const devin = info.devinInfo || {};
  const email = clean(userStatus.email);
  const base = email || clean(userStatus.name);
  const orgName = clean(devin.accountDisplayName || info.teamName || userStatus.teamName);
  const orgId = clean(devin.orgId || userStatus.teamId);
  const teamId = clean(userStatus.teamId);
  const namedOrg = orgName && orgName.toLowerCase() !== base.toLowerCase();
  const plan = clean(userStatus.teamsTier || info.teamsTier)
    .replace(/^TEAMS_TIER_/, "").split("_")
    .filter(word => word && word !== "UNSPECIFIED" && !/^V\d+$/.test(word))
    .map(word => word[0] + word.slice(1).toLowerCase()).join(" ") || clean(info.planName);
  return {
    ...(base ? { userName: namedOrg ? `${base} · ${orgName}` : base } : {}),
    ...(email ? { email } : {}),
    ...(orgId ? { orgId } : {}), ...(teamId ? { teamId } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function parseDevinUsage(userStatus = {}) {
  const st = userStatus.planStatus || {};
  const info = st.planInfo || {};
  const quotaBilling = info.billingStrategy === "BILLING_STRATEGY_QUOTA";
  const quotas = {};
  for (const [key, left, reset, hidden] of [
    ["daily", st.dailyQuotaRemainingPercent, st.dailyQuotaResetAtUnix, info.hideDailyQuota],
    ["weekly", st.weeklyQuotaRemainingPercent, st.weeklyQuotaResetAtUnix, info.hideWeeklyQuota],
  ]) {
    const at = toFiniteNumber(reset);
    // Proto JSON omits zero-valued fields. Missing share + an active reset on
    // quota billing means exhausted, never unlimited; credits plans differ.
    if (hidden || (left == null && !(quotaBilling && at > 0))) continue;
    const remainingPercentage = Math.max(0, Math.min(100, toFiniteNumber(left)));
    quotas[key] = { used: 100 - remainingPercentage, total: 100, remainingPercentage,
      resetAt: at > 0 ? parseResetTime(at) : null, unlimited: false };
  }
  const limit = toFiniteNumber(st.acuLimit);
  if (limit > 0) {
    const used = Math.max(0, toFiniteNumber(st.acuConsumed));
    quotas.acus = { used, total: limit,
      remainingPercentage: Math.max(0, Math.min(100, 100 * (1 - used / limit))),
      resetAt: parseResetTime(st.planEnd), unlimited: false };
  }
  const identity = getDevinIdentity(userStatus);
  const balanceMicros = toFiniteNumber(st.overageBalanceMicros);
  return {
    plan: identity.plan || "Devin",
    quotas,
    ...(st.planEnd ? { periodEnd: parseResetTime(st.planEnd) } : {}),
    ...(balanceMicros > 0 ? { balance: balanceMicros / 1_000_000 } : {}),
    ...(Object.keys(quotas).length === 0 ? { message: "Devin did not expose a numeric included quota for this account." } : {}),
  };
}

export async function getDevinUsage(credentials, options = {}) {
  return parseDevinUsage(await fetchDevinUserStatus(credentials, options));
}
