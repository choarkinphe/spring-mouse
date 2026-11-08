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
import { getQuotaCounter, initializeQuotaCounter } from "@/lib/redis/liveUsage.js";
import { QUOTA_LIMIT_FIELDS, QUOTA_RESET_FIELDS, QUOTA_WINDOWS, nextScheduledReset, windowStartIso } from "@/lib/quotaWindows.js";
import {
  buildModelQuotaGroupStatus,
  findModelQuotaGroup,
  readModelGroupUsageTotals,
  resolveModelQuotaGroups,
} from "@/lib/apiKeyModelQuota.js";

export { invalidateQuotaCache } from "@/lib/apiKeyQuotaCache.js";

export const API_KEY_QUOTA_WINDOWS = QUOTA_WINDOWS.map((window) => ({
  ...window,
  limitField: QUOTA_LIMIT_FIELDS[window.id],
}));

export const API_KEY_QUOTA_RESET_FIELDS = QUOTA_RESET_FIELDS;

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

export function buildApiKeyQuotaStatus(key, rules, usages = {}, modelGroupStatuses = []) {
  const normalizedRules = normalizeApiKeyQuotaRules(rules);
  const mode = normalizeApiKeyQuotaMode(key?.quotaMode);
  const windows = API_KEY_QUOTA_WINDOWS.map((window) => buildWindowStatus(window, normalizedRules, usages[window.id]));
  const enabled = mode === "limited" && rulesHaveLimit(normalizedRules);
  const exceededWindow = enabled ? windows.find((window) => window.exceeded) || null : null;
  return {
    mode,
    enabled,
    windows,
    exceededWindow,
    // Model groups are independent of the whole-key allowance: a key on
    // "unlimited" still gets its premium models throttled, which is the whole
    // point of asking for a per-model limit.
    modelGroups: modelGroupStatuses,
    exceededModelGroup: modelGroupStatuses.find((group) => group.exceededWindow) || null,
  };
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
  const cached = await getQuotaCounter(apiKeyId, window.id, nextResetAt);
  if (cached !== null) return { usedTokens: cached, nextResetAt };

  // `>=` is deliberate: the cutoff IS the window start, so a row completed at
  // exactly that instant belongs to this window. With `>` it was silently
  // dropped — measurable on a fresh key whose first request lands in the same
  // millisecond as its first window boundary.
  const usage = db.get(
    `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS usedTokens
       FROM usageHistory WHERE apiKeyId = ? AND completedAt >= ? AND status IN ('success', 'ok')`,
    [apiKeyId, windowStartIso(nextResetAt, window.durationMs)],
  );
  const usedTokens = await initializeQuotaCounter(apiKeyId, window.id, nextResetAt, usage?.usedTokens || 0);
  return { usedTokens, nextResetAt };
}

async function readUsages(db, apiKeyId, key) {
  return Object.fromEntries(await Promise.all(API_KEY_QUOTA_WINDOWS.map(async (window) => [
    window.id,
    await readWindowUsage(db, apiKeyId, window, key[API_KEY_QUOTA_RESET_FIELDS[window.id]]),
  ])));
}

// Model-group counters for one key. Run after the whole-key windows so a group's
// cold seed can reuse the same live Redis connection pool, and in one pass over
// distinct provider/model pairs rather than one query per group.
async function readModelGroupStatuses(db, key, groups) {
  if (!groups.length) return [];
  const usagesByGroup = Object.fromEntries(groups.map((group) => [group.id, {}]));
  for (const window of API_KEY_QUOTA_WINDOWS) {
    const nextResetAt = key[API_KEY_QUOTA_RESET_FIELDS[window.id]];
    if (!nextResetAt) continue;
    const limited = groups.filter((group) => group[window.limitField] !== null);
    if (!limited.length) continue;

    const missing = [];
    await Promise.all(limited.map(async (group) => {
      const cached = await getQuotaCounter(key.id, window.id, nextResetAt, modelScope(group.id));
      if (cached === null) missing.push(group);
      else usagesByGroup[group.id][window.id] = { usedTokens: cached, nextResetAt };
    }));
    if (!missing.length) continue;

    const totals = readModelGroupUsageTotals(db, key.id, window, nextResetAt, missing);
    await Promise.all(missing.map(async (group) => {
      usagesByGroup[group.id][window.id] = {
        usedTokens: await initializeQuotaCounter(key.id, window.id, nextResetAt, totals.get(group.id) || 0, modelScope(group.id)),
        nextResetAt,
      };
    }));
  }
  return groups.map((group) => buildModelQuotaGroupStatus(group, usagesByGroup[group.id]));
}

function modelScope(groupId) {
  return `model:${groupId}`;
}

async function buildStatusFor(db, key, settings) {
  const rules = normalizeApiKeyQuotaRules(settings.apiKeyQuotaRules);
  const usages = normalizeApiKeyQuotaMode(key.quotaMode) === "limited" && rulesHaveLimit(rules)
    ? await readUsages(db, key.id, key)
    : {};
  const groups = resolveModelQuotaGroups(settings.apiKeyModelQuotaRules, key);
  const modelGroups = await readModelGroupStatuses(db, key, groups);
  return buildApiKeyQuotaStatus(key, rules, usages, modelGroups);
}

export async function getApiKeyQuotaStatuses(keys = null) {
  const [db, settings, allKeys] = await Promise.all([getAdapter(), getSettings(), keys ? Promise.resolve(keys) : getApiKeys()]);
  await advanceApiKeyQuotaResets(allKeys);
  const statuses = {};
  for (const key of allKeys) {
    statuses[key.id] = await buildStatusFor(db, key, settings);
  }
  return statuses;
}

/**
 * Whole-key gate. Model groups are enforced separately (see
 * `checkModelQuotaForRequest`) because they only apply to the models they claim
 * and can route somewhere else rather than reject.
 */
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
    const key = db.get(
      `SELECT id, quotaMode, fiveHourQuotaResetAt, weeklyQuotaResetAt, modelQuotaOverrides FROM apiKeys WHERE key = ?`,
      [apiKey],
    );
    if (!key) return null;

    await advanceApiKeyQuotaResets([key]);
    const status = await buildStatusFor(db, key, settings);

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

/**
 * Model-group decision for one request. `applies: false` means no configured
 * group claims this model, which is the common case and must stay cheap — the
 * status it reads is already cached for the whole-key gate that ran before it.
 */
export async function checkModelQuotaForRequest(apiKey, { provider = null, model = null } = {}) {
  if (!apiKey || (!provider && !model)) return { applies: false, allowed: true };
  const status = await getApiKeyQuotaStatus(apiKey);
  const groups = status?.modelGroups || [];
  if (!groups.length) return { applies: false, allowed: true };
  const group = findModelQuotaGroup(groups, { provider, model });
  if (!group) return { applies: false, allowed: true };
  if (!group.exceededWindow) return { applies: true, allowed: true, group };
  return { applies: true, allowed: false, group, fallback: group.fallback || null };
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
