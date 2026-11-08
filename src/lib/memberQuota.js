// Per-member token quotas on combo routes.
//
// A combo member (`cx/gpt-5.6-sol`) may carry `quota: { fiveHourTokenLimitM,
// weeklyTokenLimitM }`: how much of that member each API key may use before the
// combo skips it — exactly like a member outside its schedule. The allowance is
// configured where the route is configured, so it can never drift from the
// models the operator actually routes to.
//
// Accounting is per API key × *executed* provider/model, the same pair a usage
// row records. Member ids are therefore resolved (`cx` → `codex`, a node prefix
// → its node id) before they are compared with usage. Two combos naming the same
// upstream model share one counter, and the tighter limit wins: a premium model
// cannot be drained twice by listing it in two combos.
//
// Counters reuse the key's scheduled reset boundaries (see `quotaWindows.js`),
// so advancing the key's windows retires member counters with the whole-key one.
import { comboModelEntry } from "open-sse/services/combo.js";
import { QUOTA_LIMIT_FIELDS, QUOTA_RESET_FIELDS, QUOTA_WINDOWS, windowStartIso } from "@/lib/quotaWindows.js";
import { getComboQuotaGeneration } from "@/lib/apiKeyQuotaCache.js";

const TARGETS_TTL_MS = 30_000;

export function memberTargetId(provider, model) {
  return provider && model ? `${provider}/${model}` : null;
}

/** Redis scope for one target. Encoded so a model id can never forge a key segment. */
export function memberQuotaScope(targetId) {
  return `member:${encodeURIComponent(targetId)}`;
}

function minLimit(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

function hasLimit(target) {
  return QUOTA_WINDOWS.some(({ id }) => target[QUOTA_LIMIT_FIELDS[id]] != null);
}

/**
 * Collect every quota'd upstream target from the combo list.
 *
 * `resolve(memberId)` returns `{ provider, model }` for a `provider/model`
 * member. Only those members can carry a quota: a sub-combo member is a route,
 * not an upstream, and its own members carry their own limits.
 *
 * `memberToTarget` maps *every* provider/model member id that resolves to a
 * quota'd target — including members that carry no quota of their own — so a
 * combo naming the same upstream under another alias is skipped too.
 */
export async function collectMemberQuotaTargets(combos, resolve) {
  const targets = new Map();
  const resolvedMembers = new Map();
  const resolveOnce = async (memberId) => {
    if (!resolvedMembers.has(memberId)) {
      let info = null;
      try {
        info = await resolve(memberId);
      } catch {
        info = null;
      }
      resolvedMembers.set(memberId, memberTargetId(info?.provider, info?.model));
    }
    return resolvedMembers.get(memberId);
  };

  for (const combo of Array.isArray(combos) ? combos : []) {
    if (!combo || combo.isActive === false) continue;
    for (const raw of Array.isArray(combo.models) ? combo.models : []) {
      const entry = comboModelEntry(raw);
      if (!entry.model || !entry.model.includes("/")) continue;
      const targetId = await resolveOnce(entry.model);
      if (!targetId || !entry.quota) continue;
      const slash = targetId.indexOf("/");
      const existing = targets.get(targetId) || {
        id: targetId,
        provider: targetId.slice(0, slash),
        model: targetId.slice(slash + 1),
        label: entry.model,
        members: [],
        combos: [],
        ...Object.fromEntries(Object.values(QUOTA_LIMIT_FIELDS).map((field) => [field, null])),
      };
      for (const field of Object.values(QUOTA_LIMIT_FIELDS)) {
        existing[field] = minLimit(existing[field], entry.quota[field] ?? null);
      }
      if (!existing.members.includes(entry.model)) existing.members.push(entry.model);
      if (combo.name && !existing.combos.includes(combo.name)) existing.combos.push(combo.name);
      targets.set(targetId, existing);
    }
  }

  for (const [targetId, target] of targets) {
    if (!hasLimit(target)) targets.delete(targetId);
  }
  const memberToTarget = new Map();
  for (const [memberId, targetId] of resolvedMembers) {
    if (targetId && targets.has(targetId)) memberToTarget.set(memberId, targetId);
  }
  return { targets, memberToTarget };
}

const EMPTY_TARGETS = Object.freeze({ targets: new Map(), memberToTarget: new Map() });
let targetsMemo = null;
let targetsLoad = null;

/**
 * The live target set, memoised per process.
 *
 * Usage writes and request gates both need it, so it must not cost a combo scan
 * per request. A combo edit bumps the combo-quota generation, which drops the
 * memo immediately; the TTL only covers node-prefix edits, which change how a
 * member resolves without touching any combo.
 */
export async function getMemberQuotaTargets() {
  const generation = getComboQuotaGeneration();
  const now = Date.now();
  if (targetsMemo && targetsMemo.generation === generation && now - targetsMemo.at < TARGETS_TTL_MS) {
    return targetsMemo.value;
  }
  if (targetsLoad && targetsLoad.generation === generation) return targetsLoad.promise;
  const promise = (async () => {
    // Imported lazily: both modules reach the DB index, which re-exports the
    // usage repo that imports this module.
    const [{ getCombos }, { getModelInfo }] = await Promise.all([
      import("@/lib/db/repos/combosRepo.js"),
      import("@/sse/services/model.js"),
    ]);
    const value = await collectMemberQuotaTargets(await getCombos(), getModelInfo);
    if (getComboQuotaGeneration() === generation) targetsMemo = { generation, at: Date.now(), value };
    return value;
  })().catch((error) => {
    console.warn("[MemberQuota] failed to load combo member quotas:", error?.message || error);
    return EMPTY_TARGETS;
  }).finally(() => {
    if (targetsLoad?.promise === promise) targetsLoad = null;
  });
  targetsLoad = { generation, promise };
  return promise;
}

function buildWindowStatus(target, window, usage) {
  const limitM = target[QUOTA_LIMIT_FIELDS[window.id]] ?? null;
  const usedTokens = Number(usage?.usedTokens || 0);
  const usedM = usedTokens / 1_000_000;
  return {
    id: window.id,
    label: window.label,
    durationMs: window.durationMs,
    limitM,
    usedM,
    usedTokens,
    remainingM: limitM === null ? null : Math.max(0, limitM - usedM),
    resetAt: usage?.nextResetAt || null,
    resetType: "scheduled",
    exceeded: limitM !== null && usedTokens >= limitM * 1_000_000,
    usedPercentage: limitM === null ? null : Math.round((usedM / limitM) * 100),
  };
}

export function buildMemberQuotaStatus(target, usages = {}) {
  const windows = QUOTA_WINDOWS.map((window) => buildWindowStatus(target, window, usages[window.id]));
  return {
    id: target.id,
    label: target.label,
    provider: target.provider,
    model: target.model,
    members: target.members,
    combos: target.combos,
    windows,
    exceededWindow: windows.find((window) => window.exceeded) || null,
  };
}

/**
 * One grouped SQL pass that seeds every target with no live counter yet. The
 * scan returns one row per distinct provider/model in the window, so a cold
 * cache costs one query no matter how many members carry a quota.
 */
export function readMemberUsageTotals(db, apiKeyId, window, nextResetAt, targetIds) {
  if (!apiKeyId || !targetIds.length) return new Map();
  const wanted = new Set(targetIds);
  // `>=` matches the whole-key seed: a row completed exactly on the window start
  // belongs to this window.
  const rows = db.all(
    `SELECT provider, model, COALESCE(SUM(promptTokens + completionTokens), 0) AS usedTokens
       FROM usageHistory
      WHERE apiKeyId = ? AND completedAt >= ? AND status IN ('success', 'ok')
      GROUP BY provider, model`,
    [apiKeyId, windowStartIso(nextResetAt, window.durationMs)],
  );
  const totals = new Map(targetIds.map((id) => [id, 0]));
  for (const row of rows) {
    const id = memberTargetId(row.provider, row.model);
    if (id && wanted.has(id)) totals.set(id, totals.get(id) + Number(row.usedTokens || 0));
  }
  return totals;
}

/**
 * Counters to carry on a usage write, so a member is charged in the same Redis
 * transaction that records the request. Charged against the model that actually
 * ran: a request that fell through to a cheaper member never lands on the
 * premium member's counter.
 */
export function buildMemberQuotaCounters({ key, provider, model, tokens, targets }) {
  const delta = Number(tokens) || 0;
  const target = targets?.get(memberTargetId(provider, model));
  if (!key?.id || delta <= 0 || !target) return [];
  const counters = [];
  for (const window of QUOTA_WINDOWS) {
    if (target[QUOTA_LIMIT_FIELDS[window.id]] == null) continue;
    const resetAt = key[QUOTA_RESET_FIELDS[window.id]];
    if (!resetAt) continue;
    counters.push({ scope: memberQuotaScope(target.id), windowId: window.id, resetAt, delta });
  }
  return counters;
}
