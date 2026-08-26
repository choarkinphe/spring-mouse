import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import {
  cacheQuotaStatus,
  clearQuotaStatusLoad,
  getCachedQuotaStatus,
  getQuotaCacheGeneration,
  getQuotaStatusLoad,
  setQuotaStatusLoad,
} from "@/lib/apiKeyQuotaCache.js";

export { invalidateQuotaCache } from "@/lib/apiKeyQuotaCache.js";

export const API_KEY_QUOTA_WINDOWS = [
  { id: "fiveHour", label: "5 小时", durationMs: 5 * 60 * 60 * 1000, limitField: "fiveHourTokenLimitM" },
  { id: "weekly", label: "近 7 天", durationMs: 7 * 24 * 60 * 60 * 1000, limitField: "weeklyTokenLimitM" },
];

export const API_KEY_QUOTA_RESET_FIELDS = {
  fiveHour: "fiveHourQuotaResetAt",
  weekly: "weeklyQuotaResetAt",
};

export const API_KEY_QUOTA_MODES = ["off", "limited", "unlimited"];

function positiveNumberOrNull(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeApiKeyQuotaRules(rules = {}) {
  return {
    fiveHourTokenLimitM: positiveNumberOrNull(rules?.fiveHourTokenLimitM),
    weeklyTokenLimitM: positiveNumberOrNull(rules?.weeklyTokenLimitM),
  };
}

export function normalizeApiKeyQuotaMode(mode) {
  return API_KEY_QUOTA_MODES.includes(mode) ? mode : "unlimited";
}

function rulesHaveLimit(rules) {
  return API_KEY_QUOTA_WINDOWS.some(({ limitField }) => normalizeApiKeyQuotaRules(rules)[limitField] !== null);
}

function buildWindowStatus(window, rules, usage) {
  const normalizedRules = normalizeApiKeyQuotaRules(rules);
  const limitM = normalizedRules[window.limitField];
  const usedTokens = Number(usage?.usedTokens || 0);
  const usedM = usedTokens / 1_000_000;
  return {
    ...window, limitM, usedM, usedTokens,
    remainingM: limitM === null ? null : Math.max(0, limitM - usedM),
    resetAt: usage?.nextResetAt || null,
    resetType: "scheduled",
    exceeded: limitM !== null && usedTokens >= limitM * 1_000_000,
    usedPercentage: limitM === null ? null : Math.round((usedM / limitM) * 100),
  };
}

export function buildApiKeyQuotaStatus(key, rules, usages = {}) {
  const normalizedRules = normalizeApiKeyQuotaRules(rules);
  const mode = normalizeApiKeyQuotaMode(key?.quotaMode);
  const windows = API_KEY_QUOTA_WINDOWS.map((window) => buildWindowStatus(window, normalizedRules, usages[window.id]));
  const enabled = mode === "limited" && rulesHaveLimit(normalizedRules);
  return { mode, enabled, windows, exceededWindow: enabled ? windows.find((window) => window.exceeded) || null : null };
}

function nextScheduledReset(value, durationMs, nowMs) {
  let nextMs = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(nextMs)) return nowMs + durationMs;
  while (nextMs <= nowMs) nextMs += durationMs;
  return nextMs;
}

export async function advanceApiKeyQuotaResets(keys = null, nowMs = Date.now()) {
  const db = await getAdapter();
  const targets = keys || await getApiKeys();
  db.transaction(() => {
    for (const key of targets) {
      for (const window of API_KEY_QUOTA_WINDOWS) {
        const field = API_KEY_QUOTA_RESET_FIELDS[window.id];
        const next = new Date(nextScheduledReset(key[field], window.durationMs, nowMs)).toISOString();
        if (key[field] !== next) {
          db.run(`UPDATE apiKeys SET ${field} = ? WHERE id = ?`, [next, key.id]);
          key[field] = next;
        }
      }
    }
  });
  return targets;
}

async function readWindowUsage(db, apiKeyId, window, nextResetAt) {
  const nextMs = new Date(nextResetAt).getTime();
  const cutoff = new Date(nextMs - window.durationMs).toISOString();
  const usage = db.get(
    `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS usedTokens
       FROM usageHistory WHERE apiKeyId = ? AND completedAt > ? AND status IN ('success', 'ok')`,
    [apiKeyId, cutoff],
  );
  return { ...usage, nextResetAt };
}

async function readUsages(db, apiKeyId, key) {
  return Object.fromEntries(await Promise.all(API_KEY_QUOTA_WINDOWS.map(async (window) => [
    window.id,
    await readWindowUsage(db, apiKeyId, window, key[API_KEY_QUOTA_RESET_FIELDS[window.id]]),
  ])));
}

export async function getApiKeyQuotaStatuses(keys = null) {
  const [db, settings, allKeys] = await Promise.all([getAdapter(), getSettings(), keys ? Promise.resolve(keys) : getApiKeys()]);
  await advanceApiKeyQuotaResets(allKeys);
  const rules = normalizeApiKeyQuotaRules(settings.apiKeyQuotaRules);
  const statuses = {};
  const hasConfiguredLimit = rulesHaveLimit(rules);
  for (const key of allKeys) {
    const usages = normalizeApiKeyQuotaMode(key.quotaMode) === "limited" && hasConfiguredLimit
      ? await readUsages(db, key.id, key)
      : {};
    statuses[key.id] = buildApiKeyQuotaStatus(key, rules, usages);
  }
  return statuses;
}

export async function checkApiKeyQuota(apiKey) {
  if (!apiKey) return { applies: false, allowed: true };
  const status = await getApiKeyQuotaStatus(apiKey);
  if (!status?.enabled) return { applies: false, allowed: true };
  return { applies: true, allowed: !status.exceededWindow, status };
}

export async function getApiKeyQuotaStatus(apiKey) {
  if (!apiKey) return null;
  const now = Date.now();
  const cached = getCachedQuotaStatus(apiKey, now);
  if (cached) return cached;

  // Collapse concurrent cold misses for one key into a single synchronous
  // SQLite aggregation. This is critical because node:sqlite blocks the event
  // loop while the query is executing.
  const existingLoad = getQuotaStatusLoad(apiKey);
  if (existingLoad) return existingLoad;

  const generation = getQuotaCacheGeneration();
  const load = (async () => {
    const [db, settings] = await Promise.all([getAdapter(), getSettings()]);
    const key = db.get(`SELECT id, quotaMode, fiveHourQuotaResetAt, weeklyQuotaResetAt FROM apiKeys WHERE key = ?`, [apiKey]);
    if (!key) return null;

    await advanceApiKeyQuotaResets([key]);
    const rules = normalizeApiKeyQuotaRules(settings.apiKeyQuotaRules);
    const usages = normalizeApiKeyQuotaMode(key.quotaMode) === "limited" && rulesHaveLimit(rules)
      ? await readUsages(db, key.id, key)
      : {};
    const status = buildApiKeyQuotaStatus(key, rules, usages);

    // An explicit reset or rule change may happen while the query is running.
    // In that case return the result to the original caller but do not let the
    // stale load repopulate the cache after invalidation.
    cacheQuotaStatus(apiKey, status, generation);
    return status;
  })().finally(() => {
    clearQuotaStatusLoad(apiKey, load);
  });

  setQuotaStatusLoad(apiKey, load);
  return load;
}

export function buildCodexUsagePayload(status) {
  const byId = Object.fromEntries((status?.windows || []).map((window) => [window.id, window]));
  const codexWindow = (id, windowMinutes) => {
    const window = byId[id];
    if (normalizeApiKeyQuotaMode(status?.mode) !== "limited" || !window?.limitM) return null;
    return {
      used_percent: Math.min(window.usedPercentage ?? 0, 100),
      window_minutes: windowMinutes,
    };
  };

  return {
    rate_limits: {
      primary: codexWindow("fiveHour", 300),
      secondary: codexWindow("weekly", 10080),
    },
  };
}
