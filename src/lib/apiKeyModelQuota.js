// Per-model-group token quotas.
//
// The whole-key quota in `apiKeyQuota.js` answers "how much may this key use".
// This answers the narrower question an operator actually asks about premium
// models: "how much of the *expensive* model may this key use before it drops to
// something cheaper". A group is a labelled matcher (`claude-opus*`, an exact
// `anthropic/claude-sonnet-4-5`, …) with its own rolling limits and an optional
// downgrade target.
//
// Accounting reuses the key's scheduled reset boundaries: every counter embeds
// the boundary it belongs to, so advancing the key's window retires the group
// counters together with the whole-key one — no second reset schedule to keep
// in step.
//
// Rules live in settings (`apiKeyModelQuotaRules`); a key may override a group's
// limits or downgrade target through its `modelQuotaOverrides` JSON column. The
// matcher itself is global, so reclassifying a model is one edit instead of one
// edit per key.
//
// This module is deliberately pure (rules, matching, status shaping). Reading
// counters and caching live in `apiKeyQuota.js`, which already owns the key-level
// aggregation; that keeps the import graph acyclic and the hot path obvious.
import { QUOTA_LIMIT_FIELDS, QUOTA_WINDOWS, windowStartIso } from "@/lib/quotaWindows.js";

const MAX_GROUPS = 40;
const MAX_PATTERNS_PER_GROUP = 60;
const MAX_PATTERNS_TOTAL = 400;
// A group id reaches a Redis key, a JSON object key, and the API response, so it
// must be boring. Renaming a group's label keeps its id, so counters survive it.
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

export const MODEL_QUOTA_COUNTER_SCOPE = "model";

function positiveNumberOrNull(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function text(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// A group id must survive the dashboard re-saving the list, because the counter
// keys embed it: an id that changes with the group's position would silently
// reset that group's usage. A label with no ASCII (e.g. a purely Chinese one)
// therefore falls back to a hash of the label itself, not to its index.
function stableId(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `g${hash.toString(36)}`;
}

function slugify(value, fallbackSeed) {
  const raw = String(value || "");
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (ID_PATTERN.test(slug)) return slug;
  return stableId(raw || fallbackSeed);
}

function normalizePatterns(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]+/) : [];
  const patterns = list.map((entry) => text(entry, 160).toLowerCase()).filter(Boolean);
  return [...new Set(patterns)].slice(0, MAX_PATTERNS_PER_GROUP);
}

/**
 * `*` is the only wildcard and it is matched case-insensitively against the whole
 * candidate. Deliberately not a regex: an operator types model ids here, and a
 * half-typed `[` must never throw on the request path.
 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

let matcherCache = new Map();
let matcherCacheSize = 0;

function matchersFor(patterns) {
  const key = patterns.join("\u0000");
  const cached = matcherCache.get(key);
  if (cached) return cached;
  const matchers = patterns.map(globToRegExp);
  // Bound by total compiled patterns, not by entries: a dashboard that keeps
  // adding models would otherwise pin one RegExp per pattern forever.
  if (matcherCacheSize + matchers.length > MAX_PATTERNS_TOTAL) {
    matcherCache = new Map();
    matcherCacheSize = 0;
  }
  matcherCacheSize += matchers.length;
  matcherCache.set(key, matchers);
  return matchers;
}

export function normalizeModelQuotaGroup(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const label = text(raw.label, 60);
  const id = slugify(raw.id || label, `group-${index + 1}`) || `group-${index + 1}`;
  return {
    id,
    label: label || id,
    enabled: raw.enabled !== false,
    models: normalizePatterns(raw.models),
    ...Object.fromEntries(QUOTA_WINDOWS.map(({ id: windowId }) => [
      QUOTA_LIMIT_FIELDS[windowId],
      positiveNumberOrNull(raw[QUOTA_LIMIT_FIELDS[windowId]]),
    ])),
    // Empty means "let the combo's own order decide"; a direct (non-combo)
    // request that runs out is then rejected rather than silently upgraded.
    fallback: text(raw.fallback, 200),
  };
}

export function normalizeModelQuotaRules(rules = {}) {
  const source = rules && typeof rules === "object" && !Array.isArray(rules) ? rules : {};
  const seen = new Set();
  const groups = (Array.isArray(source.groups) ? source.groups : [])
    .slice(0, MAX_GROUPS)
    .map(normalizeModelQuotaGroup)
    .filter(Boolean)
    // Two groups sharing an id would share a counter and corrupt each other's
    // accounting, so the later duplicate is dropped rather than merged.
    .filter((group) => {
      if (seen.has(group.id)) return false;
      seen.add(group.id);
      return true;
    });
  return { enabled: source.enabled !== false, groups };
}

/** Per-key overrides: `{ [groupId]: { fiveHourTokenLimitM, weeklyTokenLimitM, fallback, enabled } }`. */
export function normalizeModelQuotaOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [groupId, entry] of Object.entries(raw)) {
    if (!ID_PATTERN.test(groupId)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const override = {};
    for (const field of Object.values(QUOTA_LIMIT_FIELDS)) {
      // An explicit null clears the override and inherits the global value again.
      if (Object.prototype.hasOwnProperty.call(entry, field)) override[field] = positiveNumberOrNull(entry[field]);
    }
    if (typeof entry.fallback === "string") override.fallback = text(entry.fallback, 200);
    if (typeof entry.enabled === "boolean") override.enabled = entry.enabled;
    if (Object.keys(override).length) result[groupId] = override;
  }
  return result;
}

export function parseModelQuotaOverrides(value) {
  if (!value) return {};
  if (typeof value === "object") return normalizeModelQuotaOverrides(value);
  try {
    return normalizeModelQuotaOverrides(JSON.parse(value));
  } catch {
    return {};
  }
}

function groupHasLimit(group) {
  return QUOTA_WINDOWS.some(({ id }) => group[QUOTA_LIMIT_FIELDS[id]] !== null);
}

/**
 * Apply a key's overrides to the global groups. A group with no effective limit
 * is dropped: it would only contribute a status row that can never be exceeded.
 */
export function resolveModelQuotaGroups(rules, key) {
  const normalized = normalizeModelQuotaRules(rules);
  if (!normalized.enabled) return [];
  const overrides = parseModelQuotaOverrides(key?.modelQuotaOverrides);
  const groups = [];
  for (const group of normalized.groups) {
    const override = overrides[group.id] || {};
    const resolved = { ...group };
    for (const field of Object.values(QUOTA_LIMIT_FIELDS)) {
      if (Object.prototype.hasOwnProperty.call(override, field)) resolved[field] = override[field];
    }
    if (Object.prototype.hasOwnProperty.call(override, "fallback")) resolved.fallback = override.fallback;
    if (typeof override.enabled === "boolean") resolved.enabled = override.enabled;
    if (!resolved.enabled || resolved.models.length === 0 || !groupHasLimit(resolved)) continue;
    groups.push(resolved);
  }
  return groups;
}

/**
 * Does this model belong to the group?
 *
 * Both `model` and `provider/model` are matched, so a group can be scoped to one
 * provider's deployment of a shared model name (`openai/gpt-5*` vs
 * `azure/gpt-5*`). Callers pass the *executed* upstream provider/model — the same
 * pair a usage row records — so accounting and enforcement cannot disagree.
 */
export function modelMatchesGroup(group, { provider = null, model = null } = {}) {
  const candidates = [];
  if (model) candidates.push(String(model));
  if (provider && model) candidates.push(`${provider}/${model}`);
  if (!candidates.length) return false;
  return matchersFor(group.models).some((matcher) => candidates.some((candidate) => matcher.test(candidate)));
}

/** The first group claiming this model. Groups are ordered, so list the specific one first. */
export function findModelQuotaGroup(groups, target) {
  return groups.find((group) => modelMatchesGroup(group, target)) || null;
}

function buildGroupWindowStatus(group, window, usage) {
  const limitM = group[QUOTA_LIMIT_FIELDS[window.id]] ?? null;
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

export function buildModelQuotaGroupStatus(group, usages = {}) {
  const windows = QUOTA_WINDOWS.map((window) => buildGroupWindowStatus(group, window, usages[window.id]));
  return {
    id: group.id,
    label: group.label,
    models: group.models,
    fallback: group.fallback || "",
    windows,
    exceededWindow: windows.find((window) => window.exceeded) || null,
  };
}

/**
 * One grouped SQL pass that serves every group that has no live counter yet.
 *
 * Grouping in SQLite rather than filtering in JS is what keeps a cold cache
 * cheap: the scan returns one row per distinct provider/model in the window, and
 * the (few) group matchers run over that list instead of over every usage row.
 */
export function readModelGroupUsageTotals(db, apiKeyId, window, nextResetAt, groups) {
  if (!apiKeyId || !groups.length) return new Map();
  // `>=` matches the whole-key seed: the cutoff is the window start, so a row
  // completed exactly on the boundary is inside it, not before it.
  const rows = db.all(
    `SELECT provider, model, COALESCE(SUM(promptTokens + completionTokens), 0) AS usedTokens
       FROM usageHistory
      WHERE apiKeyId = ? AND completedAt >= ? AND status IN ('success', 'ok')
      GROUP BY provider, model`,
    [apiKeyId, windowStartIso(nextResetAt, window.durationMs)],
  );
  return new Map(groups.map((group) => [
    group.id,
    rows
      .filter((row) => modelMatchesGroup(group, { provider: row.provider, model: row.model }))
      .reduce((sum, row) => sum + Number(row.usedTokens || 0), 0),
  ]));
}

/**
 * Counters to carry on a usage write, so a group is charged in the same Redis
 * transaction that records the request.
 *
 * `key` must carry `modelQuotaRules` (the normalized settings value) — usage
 * writes are deliberately free of settings reads, so callers pass what they
 * already resolved rather than making the hot path fetch it again.
 */
export function buildModelQuotaCounters({ key, provider, model, tokens }) {
  const delta = Number(tokens) || 0;
  if (!key?.id || delta <= 0) return [];
  const groups = resolveModelQuotaGroups(key.modelQuotaRules, key);
  if (!groups.length) return [];
  const counters = [];
  const charged = new Set();
  for (const group of groups) {
    // A model claimed by two groups is charged once; enforcement only ever
    // reads the first match, so charging twice would desynchronise them.
    if (charged.has(group.id) || !modelMatchesGroup(group, { provider, model })) continue;
    charged.add(group.id);
    for (const window of QUOTA_WINDOWS) {
      if (group[QUOTA_LIMIT_FIELDS[window.id]] === null) continue;
      const resetAt = window.id === "fiveHour" ? key.fiveHourQuotaResetAt : key.weeklyQuotaResetAt;
      if (!resetAt) continue;
      counters.push({ scope: `model:${group.id}`, windowId: window.id, resetAt, delta });
    }
  }
  return counters;
}

