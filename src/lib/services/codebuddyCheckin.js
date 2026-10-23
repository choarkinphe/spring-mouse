import { randomUUID } from "node:crypto";
import { getProviderConnectionById, updateProviderConnectionHealth } from "@/lib/db/repos/connectionsRepo.js";
import { getCheckinState, updateCheckinState } from "@/lib/db/repos/checkinRepo.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { refreshCodebuddyToken } from "open-sse/services/tokenRefresh.js";
import { refreshWorkBuddyToken } from "open-sse/services/tokenRefresh/workbuddy.js";
import { getCredentialExpiryMs } from "open-sse/services/oauthCredentialManager.js";
import { CODEBUDDY_CHECKIN as config, supportsCodeBuddyCheckin, codeBuddyCheckinDate, checkinSite } from "@/shared/config/codebuddyCheckin.js";

// The refresh contract is per provider: the new `workbuddy` provider uses the
// WorkBuddy rotating-token endpoint and binds its credentials to the site.
const REFRESHERS = {
  "codebuddy-cn": (connection, proxy) => refreshCodebuddyToken(connection.refreshToken, null, proxy),
  workbuddy: (connection, proxy) => refreshWorkBuddyToken("workbuddy", connection, null, proxy),
};

const MESSAGES = {
  success: "签到成功",
  already_checked_in: "今日已签到",
  ineligible: "当前账号无签到资格",
  ended: "签到活动已结束",
  own_app: "请在 WorkBuddy 官方客户端签到（当前凭据不支持此活动）",
  auth: "凭据已失效，请重新授权 WorkBuddy 账号",
  identity: "无法获取账号 UID，请重新授权 WorkBuddy 账号",
  unsupported: config.unsupportedMessage,
  error: "签到请求失败，请稍后重试",
};

// Return an allowlist, never credentials, raw upstream messages or lease tokens.
export function publicCheckinState(state = {}) {
  return {
    enabled: state.enabled === true,
    status: state.status || null,
    message: state.message || null,
    lastAttemptAt: state.lastAttemptAt || null,
    lastSuccessDate: state.lastSuccessDate || null,
    reward: Number.isFinite(state.reward) ? state.reward : null,
  };
}

function outcome(status, extra = {}) {
  return { ok: status === "success" || status === "already_checked_in", status, message: MESSAGES[status], ...extra };
}

function businessResult(code) {
  if (code === 1001) return outcome("already_checked_in");
  if (code === 1002) return outcome("ineligible");
  if (code === 1003) return outcome("ended");
  return null;
}

export function createCodeBuddyCheckinService(deps = {}) {
  const load = deps.loadConnection || getProviderConnectionById;
  const getState = deps.getState || getCheckinState;
  const updateState = deps.updateState || updateCheckinState;
  const updateConnection = deps.updateConnection || updateProviderConnectionHealth;
  const fetcher = deps.fetch || proxyAwareFetch;
  // One test hook for both providers; the default dispatches per connection.
  const refresh = deps.refresh || ((connection, proxy) => {
    const refresher = REFRESHERS[connection.provider];
    return refresher ? refresher(connection, proxy) : null;
  });
  const now = deps.now || Date.now;

  async function request(path, connection, proxy) {
    const uid = connection.providerSpecificData?.codebuddyUid;
    const site = checkinSite(connection.provider);
    const response = await fetcher(`${site.origin}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        Authorization: `Bearer ${connection.accessToken}`,
        ...(uid ? { "X-User-Id": String(uid) } : {}),
        "X-Domain": site.domain,
        "X-Product": "SaaS",
        "X-IDE-Type": "WorkBuddy",
        "X-IDE-Name": "WorkBuddy",
        "X-IDE-Version": config.version,
        "X-Requested-With": "XMLHttpRequest",
        "X-Agent-Intent": "craft",
        "X-Agent-Purpose": "conversation",
      },
      body: "{}",
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    }, proxy);
    const json = await response.json().catch(() => null);
    // Business codes and credit amounts may be JSON numbers or digit strings.
    if (json && typeof json.code === "string" && /^\d+$/.test(json.code)) json.code = Number(json.code);
    return { status: response.status, httpOk: response.ok, json };
  }

  async function refreshConnection(connection, proxy) {
    if (!connection.refreshToken) return connection;
    // The shared provider refresh deduplicates rotating tokens with request-time
    // and background refresh. Its logger is intentionally omitted here.
    const tokens = await refresh(connection, proxy);
    if (!tokens?.accessToken) return connection;
    const patch = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || connection.refreshToken };
    // The WorkBuddy refresh rotates site-bound metadata with the token.
    const providerSpecificData = tokens.providerSpecificData
      ? { ...connection.providerSpecificData, ...tokens.providerSpecificData } : null;
    if (providerSpecificData) patch.providerSpecificData = providerSpecificData;
    if (Number.isFinite(tokens.expiresIn) && tokens.expiresIn > 0) {
      patch.expiresIn = tokens.expiresIn;
      patch.expiresAt = new Date(now() + tokens.expiresIn * 1000).toISOString();
    }
    const updated = await updateConnection(connection.id, (current) => ({
      // A concurrent re-authorization must not be replaced with an old refresh.
      ...(current.refreshToken === connection.refreshToken ? { update: patch } : {}),
    }));
    return updated || { ...connection, ...patch };
  }

  async function perform(connection, renewLease) {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const expiry = getCredentialExpiryMs(connection);
    if (!connection.accessToken || (expiry !== null && expiry - now() < 5 * 60 * 1000)) {
      connection = await refreshConnection(connection, proxy);
    }
    if (!connection.accessToken) return outcome("error", { message: MESSAGES.auth });
    // UID comes from the official browser authorization's account lookup.
    // Older CLI authorizations must be reconnected; never guess JWT claims.
    if (!connection.providerSpecificData?.codebuddyUid) return outcome("error", { message: MESSAGES.identity });

    let activity = await request(config.statusPath, connection, proxy);
    if (activity.status === 401) {
      const summary = await request(config.summaryPath, connection, proxy);
      // A token that can read billing but cannot claim is an app restriction,
      // not an expired token. Do not refresh/retry around that restriction.
      if (summary.httpOk && summary.json?.code === 0) return outcome("own_app");
      const refreshed = await refreshConnection(connection, proxy);
      if (refreshed.accessToken === connection.accessToken) return outcome("error", { message: MESSAGES.auth });
      connection = refreshed;
      activity = await request(config.statusPath, connection, proxy);
    }
    if (activity.status === 401 || activity.status === 403) return outcome("error", { message: MESSAGES.auth });
    const known = activity.httpOk && businessResult(activity.json?.code);
    if (known) return known;
    if (!activity.httpOk || activity.json?.code !== 0) return outcome("error");
    const data = activity.json.data;
    if (!data || typeof data.active !== "boolean" || typeof data.today_checked_in !== "boolean") return outcome("error");
    if (!data.active) return outcome("ended");
    if (data.today_checked_in) return outcome("already_checked_in");

    // Re-check immediately before the side effect: an old request may have
    // resumed after its lease expired and another worker already claimed.
    if (!await renewLease()) return { ok: false, skipped: "lease_lost", message: "签到任务已过期，请重试" };
    const claimed = await request(config.claimPath, connection, proxy);
    if (claimed.status === 401) {
      const summary = await request(config.summaryPath, connection, proxy);
      return summary.httpOk && summary.json?.code === 0
        ? outcome("own_app") : outcome("error", { message: MESSAGES.auth });
    }
    const business = claimed.httpOk && businessResult(claimed.json?.code);
    if (business) return business;
    if (!claimed.httpOk || claimed.json?.code !== 0 || !claimed.json.data || typeof claimed.json.data !== "object" || Array.isArray(claimed.json.data)) return outcome("error");
    const credit = claimed.json.data.credit;
    const reward = typeof credit === "number" || (typeof credit === "string" && credit.trim()) ? Number(credit) : null;
    return outcome("success", {
      reward: reward !== null && Number.isFinite(reward) && reward >= 0 ? reward : null,
      ...(claimed.json.data.credit_delayed === true ? { message: "签到成功，积分将延迟到账" } : {}),
    });
  }

  async function run(connectionId, { automatic = false } = {}) {
    const connection = await load(connectionId);
    if (!connection) return { ok: false, httpStatus: 404, message: "账号不存在" };
    if (!supportsCodeBuddyCheckin(connection)) return { ok: false, httpStatus: 400, message: MESSAGES.unsupported };
    if (connection.isActive === false) return { ok: false, httpStatus: 400, message: "请先启用账号", checkin: publicCheckinState(await getState(connectionId)) };

    const startedAt = now();
    const date = codeBuddyCheckinDate(startedAt);
    const leaseId = randomUUID();
    let skipped;
    let acquired = false;
    const current = await updateState(connectionId, (state) => {
      if (automatic && state.enabled !== true) { skipped = "disabled"; return null; }
      if (state.lastSuccessDate === date) { skipped = "today"; return null; }
      if (state.leaseUntil > startedAt) { skipped = "running"; return null; }
      if (automatic && (state.terminalDate === date || state.retryAfter > startedAt)) { skipped = "cooldown"; return null; }
      acquired = true;
      return { leaseId, leaseUntil: startedAt + config.leaseMs, lastAttemptAt: new Date(startedAt).toISOString() };
    });
    if (!acquired) return {
      ok: skipped === "today", skipped,
      message: skipped === "today" ? MESSAGES.already_checked_in : skipped === "running" ? "签到正在进行中" : current.message,
      checkin: publicCheckinState(current),
    };

    let result;
    try {
      result = await perform(connection, async () => {
        let valid = false;
        await updateState(connectionId, (state) => {
          if (state.leaseId !== leaseId || state.leaseUntil <= now() || state.lastSuccessDate === date) return null;
          valid = true;
          return { leaseUntil: now() + config.leaseMs };
        });
        return valid;
      });
    } catch { result = outcome("error"); }
    if (result.skipped) return { ...result, checkin: publicCheckinState(await getState(connectionId)) };
    const finished = await updateState(connectionId, (state) => {
      if (state.leaseId !== leaseId) return null;
      return {
        leaseId: null, leaseUntil: 0,
        status: result.status, message: result.message, reward: result.reward ?? null,
        ...(result.ok ? { lastSuccessDate: date } : {}),
        terminalDate: ["ineligible", "ended", "own_app"].includes(result.status) ? date : null,
        retryAfter: result.status === "error" ? now() + config.retryMs : 0,
      };
    });
    return { ...result, checkin: publicCheckinState(finished) };
  }

  async function setEnabled(connectionId, enabled) {
    return publicCheckinState(await updateState(connectionId, () => ({ enabled })));
  }

  return { run, setEnabled };
}

const service = createCodeBuddyCheckinService();
export const runCodeBuddyCheckin = service.run;
export const setCodeBuddyCheckinEnabled = service.setEnabled;
