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
  buildMemberQuotaStatus,
  getMemberQuotaTargets,
  memberQuotaScope,
  readMemberUsageTotals,
} from "@/lib/memberQuota.js";

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

export function buildApiKeyQuotaStatus(key, rules, usages = {}, memberQuotas = []) {
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
    // Combo member quotas are independent of the whole-key allowance: a key on
    // "unlimited" still has its premium members skipped once it used its share,
    // which is the point of putting a limit on a member.
    memberQuotas,
    exhaustedMembers: memberQuotas.filter((member) => member.exceededWindow).map((member) => member.id),
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

// Member counters for one key: one Redis read per quota'd member and window,
// and one grouped SQL pass per window for whatever has no live counter yet.
async function readMemberQuotaStatuses(db, key, targets) {
  const list = [...targets.values()];
  if (!list.length) return [];
  const usagesByTarget = Object.fromEntries(list.map((target) => [target.id, {}]));
  for (const window of API_KEY_QUOTA_WINDOWS) {
    const nextResetAt = key[API_KEY_QUOTA_RESET_FIELDS[window.id]];
    if (!nextResetAt) continue;
    const limited = list.filter((target) => target[window.limitField] != null);
    if (!limited.length) continue;

    const missing = [];
    await Promise.all(limited.map(async (target) => {
      const cached = await getQuotaCounter(key.id, window.id, nextResetAt, memberQuotaScope(target.id));
      if (cached === null) missing.push(target);
      else usagesByTarget[target.id][window.id] = { usedTokens: cached, nextResetAt };
    }));
    if (!missing.length) continue;

    const totals = readMemberUsageTotals(db, key.id, window, nextResetAt, missing.map((target) => target.id));
    await Promise.all(missing.map(async (target) => {
      usagesByTarget[target.id][window.id] = {
        usedTokens: await initializeQuotaCounter(key.id, window.id, nextResetAt, totals.get(target.id) || 0, memberQuotaScope(target.id)),
        nextResetAt,
      };
    }));
  }
  return list.map((target) => buildMemberQuotaStatus(target, usagesByTarget[target.id]));
}

async function buildStatusFor(db, key, settings, memberTargets) {
  const rules = normalizeApiKeyQuotaRules(settings.apiKeyQuotaRules);
  const usages = normalizeApiKeyQuotaMode(key.quotaMode) === "limited" && rulesHaveLimit(rules)
    ? await readUsages(db, key.id, key)
    : {};
  const memberQuotas = await readMemberQuotaStatuses(db, key, memberTargets.targets);
  return buildApiKeyQuotaStatus(key, rules, usages, memberQuotas);
}

export async function getApiKeyQuotaStatuses(keys = null) {
  const [db, settings, allKeys, memberTargets] = await Promise.all([
    getAdapter(),
    getSettings(),
    keys ? Promise.resolve(keys) : getApiKeys(),
    getMemberQuotaTargets(),
  ]);
  await advanceApiKeyQuotaResets(allKeys);
  const statuses = {};
  for (const key of allKeys) {
    statuses[key.id] = await buildStatusFor(db, key, settings, memberTargets);
  }
  return statuses;
}

/**
 * Whole-key gate. Member quotas are enforced inside combo routing instead (see
 * `getComboMemberQuotaGate`), because an exhausted member is skipped, not
 * rejected.
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
    const [db, settings, memberTargets] = await Promise.all([getAdapter(), getSettings(), getMemberQuotaTargets()]);
    const key = db.get(
      `SELECT id, quotaMode, fiveHourQuotaResetAt, weeklyQuotaResetAt FROM apiKeys WHERE key = ?`,
      [apiKey],
    );
    if (!key) return null;

    await advanceApiKeyQuotaResets([key]);
    const status = await buildStatusFor(db, key, settings, memberTargets);

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

const NO_MEMBER_GATE = Object.freeze({ isExhausted: () => false, exhaustedFor: () => null });

/**
 * Member-quota view for one request, resolved once and then consulted
 * synchronously by the combo filters. `isExhausted(memberId)` takes the member
 * id exactly as written in the combo (`cx/gpt-5.6-sol`); alias resolution was
 * done when the targets were collected.
 *
 * Fails open: a quota read that errors must never take a working route down.
 */
export async function getComboMemberQuotaGate(apiKey) {
  if (!apiKey) return NO_MEMBER_GATE;
  try {
    const { memberToTarget } = await getMemberQuotaTargets();
    if (!memberToTarget.size) return NO_MEMBER_GATE;
    const status = await getApiKeyQuotaStatus(apiKey);
    const exhausted = new Map(
      (status?.memberQuotas || []).filter((member) => member.exceededWindow).map((member) => [member.id, member]),
    );
    if (!exhausted.size) return NO_MEMBER_GATE;
    const exhaustedFor = (memberId) => {
      const targetId = typeof memberId === "string" ? memberToTarget.get(memberId) : null;
      return targetId ? exhausted.get(targetId) || null : null;
    };
    return { isExhausted: (memberId) => Boolean(exhaustedFor(memberId)), exhaustedFor };
  } catch (error) {
    console.warn("[MemberQuota] gate unavailable, allowing request:", error?.message || error);
    return NO_MEMBER_GATE;
  }
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
