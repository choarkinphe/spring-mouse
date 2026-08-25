import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:8008";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

// Settings cache with TTL to reduce frequent DB reads
let settingsCache = null;
let settingsCacheExpire = 0;
const SETTINGS_TTL_MS = 5000; // 5秒缓存，可按需调整

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  cloudflareTunnelEnabled: false,
  cloudflareTunnelToken: "",
  cloudflareTunnelPublicUrl: "",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  providerStrategies: {},
  quotaVisibility: {},
  dashboardQuotaOrder: [],
  dashboardQuotaHidden: [],
  comboStrategies: {},
  requireLogin: true,
  requireApiKey: true,
  ipAccessEnabled: false,
  ipAccessMode: "allowlist",
  ipAllowlist: [],
  ipBlocklist: [],
  totpEnabled: false,
  totpSecretEncrypted: null,
  totpRecoveryCodeHashes: [],
  totpPendingSecretEncrypted: null,
  totpPendingRecoveryCodeHashes: [],
  apiKeyQuotaRules: { fiveHourTokenLimitM: null, weeklyTokenLimitM: null },
  tunnelDashboardAccess: true,
  enableObservability: false,
  enableRequestLogFileDumps: process.env.ENABLE_REQUEST_LOG_FILE_DUMPS === "true",
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const persisted = { ...(raw || {}) };
  // Routing is now configured where it is used: per-provider for accounts and
  // per-combo for model routing. Ignore legacy global defaults on read.
  delete persisted.fallbackStrategy;
  delete persisted.stickyRoundRobinLimit;
  delete persisted.comboStrategy;
  delete persisted.comboStickyRoundRobinLimit;

  const merged = { ...DEFAULT_SETTINGS, ...persisted };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const now = Date.now();
  // 如果缓存存在且未过期，直接返回缓存
  if (settingsCache && now < settingsCacheExpire) {
    return settingsCache;
  }

  // 缓存过期或不存在，从数据库读取
  const raw = await readRaw();
  settingsCache = mergeWithDefaults(raw);
  settingsCacheExpire = now + SETTINGS_TTL_MS;
  return settingsCache;
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });

  // 主动失效缓存，确保下次读取获取最新数据
  settingsCache = null;
  settingsCacheExpire = 0;

  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
