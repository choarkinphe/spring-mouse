import { execFile } from "node:child_process";
import { stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveQoderCredentials } from "open-sse/services/qoderModels.js";
import { getQoderEndpoints, withQoderProviderRegion } from "open-sse/shared/qoder/constants.js";

// Protocol reference (MIT): magpie-community/plugins, revision
// 270b228a964dc4f7fb55b211e23f7a2c7b7329f6, packages/qoder/index.mjs
// (campaignCall, campaignMachine, checkin), testdata/campaigns-1028.json.
// Campaigns use ordinary Bearer auth, NOT the chat endpoint's COSY envelope.
const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
const DAY_MS = 86_400_000;
const CLOCK_ROOM_MS = 60_000;
const IDENTITY_TTL_MS = 60 * 60 * 1000;
const identities = new Map();

// A provider day starts at 10:00 UTC+8, not at local/Beijing midnight.
export function qoderCheckinDate(timestamp = Date.now()) {
  return new Date(Number(timestamp) - 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function result(status, message, extra = {}) {
  return { ok: status === "success" || status === "already_checked_in", status, message, ...extra };
}

function timestamp(value) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  return Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

function nextOpening(campaign) {
  const start = timestamp(campaign.startAt);
  const end = timestamp(campaign.endAt);
  return start !== null && end !== null ? Math.max(end, start + DAY_MS) + CLOCK_ROOM_MS : null;
}

function rewardOf(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function validateIdentity(identity) {
  const headers = {};
  for (const [header, field] of [["Cosy-MachineToken", "machineToken"], ["Cosy-MachineType", "machineType"]]) {
    const value = identity?.[field];
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || !/^[\x20-\x7e]+$/.test(value)) {
      throw new Error("invalid Qoder device identity");
    }
    headers[header] = value.trim();
  }
  return headers;
}

// Read only an already installed official desktop/CLI helper. Never download a
// binary, accept executable paths from connection metadata, or manufacture its
// device identity from the chat UUID. UID is stdin, never a command-line arg.
export async function readQoderMachineIdentity(region, uid) {
  const cn = region === "cn";
  const app = cn ? "Qoder CN" : "Qoder";
  const prefix = cn ? "QODERCN_" : "QODER_";
  const home = homedir();
  const binary = process.platform === "win32" ? "runtime-info.exe" : "runtime-info";
  const candidates = [];
  if (process.platform === "darwin") {
    for (const root of ["/Applications", join(home, "Applications")]) {
      candidates.push(join(root, `${app}.app`, "Contents", "Resources", "umid", binary));
    }
  } else if (process.platform === "linux") {
    candidates.push(join("/opt", cn ? "Qoder-CN" : "Qoder", "resources", "umid", binary));
  } else if (process.platform === "win32") {
    candidates.push(join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", app, "resources", "umid", binary));
    for (const root of [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean)) {
      candidates.push(join(root, app, "resources", "umid", binary));
    }
  }
  const config = process.env[`${prefix}CONFIG_DIR`] || join(
    process.env[`${prefix}CLI_HOME`] || home,
    process.env[`${prefix}CONFIG_DIR_NAME`] || (cn ? ".qoder-cn" : ".qoder"),
  );
  const cache = join(config, ".bin");
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => []);
  const pattern = process.platform === "win32"
    ? new RegExp(`^umid-win32-${process.arch}-[a-f0-9]+$`, "i")
    : new RegExp(`^runtime-info-${process.platform}-${process.arch}-[a-f0-9]+$`, "i");
  const cached = [];
  for (const entry of entries) {
    if (!pattern.test(entry.name) || !(process.platform === "win32" ? entry.isDirectory() : entry.isFile())) continue;
    const path = process.platform === "win32" ? join(cache, entry.name, binary) : join(cache, entry.name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) cached.push({ path, time: info.mtimeMs });
  }
  candidates.push(...cached.sort((a, b) => b.time - a.time).map((entry) => entry.path));
  let file;
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    // Do not execute a helper another local user can replace or modify.
    if (process.platform !== "win32" && ((info.mode & 0o022) || (typeof process.getuid === "function" && info.uid !== 0 && info.uid !== process.getuid()))) continue;
    file = candidate;
    break;
  }
  if (!file || !uid) throw new Error("Qoder native device identity unavailable");
  const key = `${region}:${uid}:${file}`;
  const cachedIdentity = identities.get(key);
  if (cachedIdentity && cachedIdentity.until > Date.now()) return cachedIdentity.promise;
  const promise = new Promise((resolve, reject) => {
    const args = process.platform === "linux" ? [cn ? "0" : "3"] : [cn ? "0" : "3", "--account-stdin"];
    const child = execFile(file, args, { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) { reject(new Error("Qoder native device identity unavailable")); return; }
      try { resolve(validateIdentity(JSON.parse(stdout.trim().split(/\r?\n/, 1)[0]))); } catch { reject(new Error("Invalid Qoder native device identity")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(process.platform === "linux" ? undefined : JSON.stringify({ account: uid }) + "\n");
  });
  identities.set(key, { until: Date.now() + IDENTITY_TTL_MS, promise });
  try { return await promise; } catch (error) { identities.delete(key); throw error; }
}

/** Perform one account's check-in. The caller owns leases and persistence.
 * refreshConnection(connection, proxy) must return a persisted fresh connection;
 * it must share the normal rotating-token lock. nextAttemptAt is epoch millis.
 */
export async function performQoderCheckin(connection, {
  fetch: fetcher = proxyAwareFetch,
  refreshConnection,
  now = Date.now,
  renewLease = async () => true,
  proxy = null,
  readMachineIdentity = readQoderMachineIdentity,
} = {}) {
  const currentTime = () => typeof now === "function" ? Number(now()) : Number(now);
  let credentials;
  try {
    credentials = { ...connection, providerSpecificData: withQoderProviderRegion(connection.provider, connection.providerSpecificData) };
  } catch {
    return result("unsupported", "Qoder 凭据与服务区域不匹配，请重新授权对应区域账号");
  }
  if (connection.isActive === false) return result("unsupported", "请先启用账号");
  const region = credentials.providerSpecificData.region;
  const endpoints = getQoderEndpoints(region);
  const base = `${endpoints.openapi}${CAMPAIGNS_PATH}`;
  let identity = {};
  let refreshed = false;
  const resolve = async () => {
    credentials = await resolveQoderCredentials(credentials, proxy, AbortSignal.timeout(20_000));
    if (!credentials?.accessToken || !/^(dt-|jt-)/.test(credentials.accessToken)) throw new Error("auth");
  };
  const refresh = async () => {
    if (refreshed || typeof refreshConnection !== "function" || !credentials.refreshToken) return false;
    refreshed = true;
    const previous = credentials.accessToken;
    const updated = await refreshConnection(credentials, proxy);
    if (!updated) return false;
    const bound = withQoderProviderRegion(connection.provider, updated.providerSpecificData);
    if (bound.userId && bound.userId !== credentials.providerSpecificData.userId) throw new Error("auth");
    credentials = { ...updated, providerSpecificData: bound };
    await resolve();
    return credentials.accessToken !== previous;
  };
  let claimExpiresAt = null;
  const call = async (url, method = "GET") => {
    if (method === "POST") {
      if (!await renewLease()) return null;
      if (claimExpiresAt !== null && currentTime() >= claimExpiresAt) throw new Error("campaign expired");
    }
    return fetcher(url, {
      method, redirect: "error",
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.accessToken}`,
        "Cosy-ClientType": "10", "User-Agent": "Qoder", ...identity,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(20_000),
    }, proxy);
  };
  const request = async (url, method) => {
    let response = await call(url, method);
    // A campaign-list read may renew an expired token once. A rejected claim
    // may instead be the vendor's own-app eligibility gate: do not rotate a
    // token or replay a side effect to work around that gate.
    if (method === "GET" && response && [401, 403].includes(response.status) && await refresh()) response = await call(url, method);
    return response;
  };
  const leaseLost = () => ({ ok: false, skipped: "lease_lost", status: "error", message: "签到任务已过期，请重试" });
  const authError = () => result("error", "Qoder 凭据已失效，请重新授权账号");
  try {
    const expiry = credentials.expiresAt ? new Date(credentials.expiresAt).getTime() : NaN;
    if (Number.isFinite(expiry) && expiry - currentTime() < 5 * 60 * 1000 && credentials.refreshToken) await refresh();
    await resolve();
    try {
      const read = await readMachineIdentity(region, credentials.providerSpecificData.userId);
      identity = validateIdentity({ machineToken: read?.["Cosy-MachineToken"], machineType: read?.["Cosy-MachineType"] });
    } catch {
      if (region !== "cn") return result("own_app", "Qoder 国际版签到需要官方设备身份，请在当前主机安装并登录 Qoder 官方客户端或 CLI，或在官方客户端签到");
    }
    const listed = await request(base, "GET");
    if ([401, 403].includes(listed.status)) return authError();
    if (listed.status !== 200) return result("error", "Qoder 签到活动查询失败，请稍后重试");
    const list = await listed.json().catch(() => null);
    if (!list || !Array.isArray(list.campaigns)) return result("error", "Qoder 签到活动响应无效，请稍后重试");
    const campaigns = list.campaigns.filter((c) => c && c.actionType === "CLAIM_BENEFIT" && (!c.benefit?.kind || c.benefit.kind === "CREDITS"));
    const time = currentTime();
    const active = (c) => {
      const start = timestamp(c.startAt), end = timestamp(c.endAt);
      return start !== null && end !== null && start < end && start <= time && time < end;
    };
    const campaign = campaigns.find((c) => c.claimStatus === "CLAIMABLE" && active(c));
    if (!campaign) {
      const done = campaigns.find((c) => c.claimStatus === "CLAIMED" && active(c));
      if (done) return result("already_checked_in", "本轮 Qoder 积分已领取", {
        reward: rewardOf(done.benefit?.amount), nextAttemptAt: nextOpening(done), successDate: qoderCheckinDate(time),
      });
      const future = campaigns.flatMap((c) => {
        const start = timestamp(c.startAt);
        return [start !== null && start > time ? start + CLOCK_ROOM_MS : null, nextOpening(c)];
      }).filter((t) => t !== null && t > time);
      if (campaigns.length) return result("error", "当前暂无可领取的 Qoder 每日积分，请等待活动开放", {
        ...(future.length ? { nextAttemptAt: Math.min(...future) } : {}),
      });
      return result("ineligible", "Qoder 当前未向此账号或设备提供每日积分活动，请在官方客户端确认资格");
    }
    if (typeof campaign.campaignId !== "string" || !campaign.campaignId.trim() || campaign.campaignId.length > 256) {
      return result("error", "Qoder 签到活动响应无效，请稍后重试");
    }
    // Time may have advanced while validating/renewing a shared lease. Never
    // knowingly claim an expired campaign or retry an ambiguous failed POST.
    claimExpiresAt = timestamp(campaign.endAt);
    const claimed = await request(`${base}/${encodeURIComponent(campaign.campaignId)}/claim`, "POST");
    if (!claimed) return leaseLost();
    if ([401, 403].includes(claimed.status)) return result("own_app", "Qoder 已拒绝此设备或凭据领取积分，请在 Qoder 官方客户端确认签到资格");
    if (claimed.status !== 200) return result("error", "Qoder 积分领取失败，请稍后查询活动状态");
    const claim = await claimed.json().catch(() => null);
    const response = claim?.data && typeof claim.data === "object" ? claim.data : claim;
    if (response?.status !== "CLAIMED") return result("error", "Qoder 未确认积分领取，请稍后查询活动状态");
    const amount = rewardOf(response.benefit?.amount) ?? rewardOf(campaign.benefit?.amount);
    return result("success", "Qoder 每日积分领取成功", {
      reward: amount, nextAttemptAt: nextOpening(campaign), successDate: qoderCheckinDate(time),
    });
  } catch (error) {
    // Never return upstream text, SDK tokens, refresh tokens or helper output.
    return error?.message === "auth" ? authError() : result("error", "Qoder 签到请求失败，请稍后重试");
  }
}
