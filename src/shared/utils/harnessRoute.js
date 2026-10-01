/**
 * Harness routing helpers.
 *
 * A "harness" is an external tool (Claude Desktop, Claude Code, Codex, …) that
 * is pointed at a dedicated URL prefix instead of the bare `/v1` API. The
 * prefix is the identity: `POST /claude-code/v1/messages` is Claude Code,
 * `POST /codex/v1/responses` is Codex. Next.js rewrites route these prefixes
 * onto the normal `/api/v1/*` handlers **without changing `request.url`**, so
 * the handler still sees the original path and can tell which tool called.
 *
 * Identifying by path rather than User-Agent is deliberate: a UA is a
 * self-reported string that changes with every tool release, while the prefix
 * is chosen by the operator and is therefore stable and predictable.
 *
 * Per-harness model mappings rewrite the client's model name (e.g. Desktop's
 * `claude-opus-5`) to a real target (e.g. `cx/gpt-5.6-sol`) before routing, so
 * a tool that only understands its own model ids still reaches any channel.
 */

// Built-in harnesses. `prefix` is the first path segment; it is also the key
// used in `settings.harnessProfiles`. Keep this in sync with the rewrites in
// next.config.mjs and PUBLIC_PREFIXES in src/dashboardGuard.js.
export const BUILTIN_HARNESSES = [
  { prefix: "claude-desktop", label: "Claude Desktop" },
  { prefix: "claude-code", label: "Claude Code" },
  { prefix: "codex", label: "Codex" },
];

const BUILTIN_PREFIX_SET = new Set(BUILTIN_HARNESSES.map((item) => item.prefix));

// The model ids each tool sends on its own. These are the tool's vocabulary, not
// Spring Mouse targets: the dashboard pairs one of these with a combo, so the
// left-hand side of a mapping is a fixed choice rather than free text. Ids are
// taken from the tool's own defaults and kept in the shape the tool emits
// (Claude Desktop and Claude Code both speak Anthropic ids; Codex speaks
// OpenAI/Codex ids), because that is exactly what arrives in `body.model`.
//
// This list is a **starting point, not a closed set**: a tool release can start
// sending an id that was never in it (real traffic has carried `claude-opus-5`
// and `claude-sonnet-4-5`), and only the operator can see that. So the dashboard
// lets the operator append their own ids — see `normalizeHarnessModels` and
// `settings.harnessModels` — and those are merged on top of these defaults.
const CLAUDE_MODEL_IDS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
];

export const HARNESS_MODEL_OPTIONS = {
  "claude-desktop": [...CLAUDE_MODEL_IDS],
  "claude-code": [...CLAUDE_MODEL_IDS],
  codex: [
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5-codex",
    "gpt-5.2",
  ],
};

/**
 * Validate and normalize `settings.harnessModels` — operator-maintained extra
 * model ids per harness prefix. These are merged with `HARNESS_MODEL_OPTIONS`
 * for the mapping table's left-hand dropdown, so an operator whose tool sends an
 * id the built-in list does not know about can add it without a release.
 *
 * Duplicates (within the list and against the built-ins) are dropped rather than
 * rejected, so re-saving a list the UI already merged cannot fail.
 */
export function normalizeHarnessModels(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harnessModels must be an object");
  }

  const result = {};
  for (const [prefix, models] of Object.entries(value)) {
    if (!BUILTIN_PREFIX_SET.has(prefix)) continue;
    if (!Array.isArray(models)) continue;

    const seen = new Set(HARNESS_MODEL_OPTIONS[prefix] || []);
    const kept = [];
    for (const model of models.slice(0, MAX_HARNESS_MODELS)) {
      if (!isValidHarnessMatch(model)) continue;
      const trimmed = model.trim();
      // A custom entry only earns its place by not being a built-in; otherwise
      // the dropdown would show the same id twice.
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      kept.push(trimmed);
    }
    if (kept.length > 0) result[prefix] = kept;
  }
  return result;
}

/**
 * The full model list for one harness: built-ins first, then the operator's
 * custom ids, de-duplicated. Order is stable so the dropdown does not reshuffle
 * between renders.
 */
export function resolveHarnessModelOptions(prefix, customModels) {
  const builtin = HARNESS_MODEL_OPTIONS[prefix] || [];
  const custom = Array.isArray(customModels?.[prefix]) ? customModels[prefix] : [];
  const seen = new Set(builtin);
  const merged = [...builtin];
  for (const model of custom) {
    if (typeof model !== "string" || !model.trim()) continue;
    const trimmed = model.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged;
}

const MAX_MATCH_LENGTH = 200;
const MAX_TARGET_LENGTH = 200;
const MAX_MAPPINGS = 100;
const MAX_HARNESS_MODELS = 50;

/** First path segment of a request URL, or null when unparseable. */
export function resolveHarnessPrefix(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const segment = pathname.split("/").filter(Boolean)[0] || null;
  if (!segment || !BUILTIN_PREFIX_SET.has(segment)) return null;
  return segment;
}

/**
 * Match a client model name against a harness's mapping list.
 *
 * `match` supports a single trailing and/or leading `*` wildcard:
 * `claude-opus-*`, `*-preview`, `claude-*-4-5`. An exact (wildcard-free) entry
 * always wins over a wildcard one, so a specific override can sit next to a
 * broad default. Among wildcards the longest literal wins, which makes
 * `claude-opus-*` beat `claude-*`.
 *
 * Returns the mapping's `target`, or null when nothing matches.
 */
export function matchHarnessMapping(model, mappings) {
  if (typeof model !== "string" || !model || !Array.isArray(mappings)) return null;

  let best = null;
  for (const mapping of mappings) {
    const match = typeof mapping?.match === "string" ? mapping.match.trim() : "";
    const target = typeof mapping?.target === "string" ? mapping.target.trim() : "";
    if (!match || !target) continue;

    const score = matchScore(match, model);
    if (score == null) continue;
    if (!best || score > best.score) best = { score, target };
  }
  return best ? best.target : null;
}

/**
 * Score a pattern against a model name. Exact match scores highest; wildcards
 * score by literal length so the most specific pattern wins. Returns null when
 * the pattern does not match.
 */
function matchScore(pattern, model) {
  if (!pattern.includes("*")) return pattern === model ? Number.MAX_SAFE_INTEGER : null;

  const star = pattern.indexOf("*");
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);

  // Only a single leading/trailing wildcard is supported. A `*` in the middle
  // would need full glob semantics; reject it rather than guess.
  if (suffix.includes("*")) return null;
  if (prefix && suffix) return null;

  if (!model.startsWith(prefix) || !model.endsWith(suffix)) return null;
  if (model.length < prefix.length + suffix.length) return null;
  return prefix.length + suffix.length;
}

/** True when a value is a usable provider/model or combo-name target. */
export function isValidHarnessTarget(value) {
  if (typeof value !== "string") return false;
  const target = value.trim();
  if (!target || target.length > MAX_TARGET_LENGTH) return false;
  if (/[\s\p{Cc}]/u.test(target)) return false;
  const slash = target.indexOf("/");
  if (slash >= 0) return slash > 0 && !target.endsWith("/");
  return /^[a-zA-Z0-9_.-]+$/.test(target);
}

/** True when a value is a usable match pattern. */
export function isValidHarnessMatch(value) {
  if (typeof value !== "string") return false;
  const match = value.trim();
  if (!match || match.length > MAX_MATCH_LENGTH) return false;
  if (/[\s\p{Cc}]/u.test(match)) return false;
  // At most one `*`, and only as a leading or trailing wildcard.
  const stars = match.split("*").length - 1;
  if (stars === 0) return true;
  if (stars > 1) return false;
  const star = match.indexOf("*");
  return star === 0 || star === match.length - 1;
}

/**
 * Validate and normalize the `harnessProfiles` settings value. Unknown
 * prefixes are dropped (a prefix cannot take effect without a matching
 * rewrite, which is build-time static), and invalid mappings are dropped
 * rather than throwing so one bad row cannot brick the settings page.
 */
export function normalizeHarnessProfiles(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harnessProfiles must be an object");
  }

  const result = {};
  for (const [prefix, profile] of Object.entries(value)) {
    if (!BUILTIN_PREFIX_SET.has(prefix)) continue;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue;

    const rawMappings = Array.isArray(profile.mappings) ? profile.mappings : [];
    const mappings = [];
    for (const mapping of rawMappings.slice(0, MAX_MAPPINGS)) {
      const match = typeof mapping?.match === "string" ? mapping.match.trim() : "";
      const target = typeof mapping?.target === "string" ? mapping.target.trim() : "";
      if (!isValidHarnessMatch(match) || !isValidHarnessTarget(target)) continue;
      mappings.push({ match, target });
    }

    const label = typeof profile.label === "string" && profile.label.trim()
      ? profile.label.trim().slice(0, 60)
      : BUILTIN_HARNESSES.find((item) => item.prefix === prefix)?.label || prefix;

    result[prefix] = {
      enabled: profile.enabled !== false,
      label,
      mappings,
    };
  }
  return result;
}

/**
 * Read the effective harness profiles, synthesizing a Claude Desktop profile
 * from the legacy `claudeMessagesRoute` setting when no explicit
 * `harnessProfiles` entry exists yet. This keeps existing installs working
 * after the setting moves out of channel management.
 */
export function resolveHarnessProfiles(settings) {
  const explicit = normalizeHarnessProfiles(settings?.harnessProfiles);
  if (Object.keys(explicit).length > 0) return explicit;

  const legacy = typeof settings?.claudeMessagesRoute === "string"
    ? settings.claudeMessagesRoute.trim()
    : "";
  if (!legacy) return explicit;

  return {
    "claude-desktop": {
      enabled: true,
      label: "Claude Desktop",
      mappings: [{ match: "claude-*", target: legacy }],
    },
  };
}

/**
 * Resolve the harness target for a request, or null when the request is not
 * harness-prefixed, the profile is disabled, or no mapping matches.
 *
 * Returns `{ prefix, profile, target }` so the caller can record which harness
 * handled the request.
 */
export function resolveHarnessTarget(url, model, settings) {
  const prefix = resolveHarnessPrefix(url);
  if (!prefix) return null;

  const profiles = resolveHarnessProfiles(settings);
  const profile = profiles[prefix];
  if (!profile || profile.enabled === false) return null;

  const target = matchHarnessMapping(model, profile.mappings);
  if (!target) return null;

  return { prefix, profile, target };
}
