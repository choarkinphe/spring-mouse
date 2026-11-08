// Combo-only routing: when enabled, API keys may call combos only — not a
// provider/model pair and not a bare provider model. A combo is the unit the
// operator configures access, schedule and member quotas on, so a direct call
// would bypass all three.
//
// Keys carrying one of `exemptTags` (by default the operator's own `god` and
// `sys` tags) keep direct access for debugging and internal tooling.
import { hasAccessTagOverlap, normalizeAccessTags } from "./accessTags.js";

export const DEFAULT_COMBO_ONLY_EXEMPT_TAGS = Object.freeze(["god", "sys"]);

export function normalizeComboOnlyRouting(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const exemptTags = source.exemptTags === undefined
    ? [...DEFAULT_COMBO_ONLY_EXEMPT_TAGS]
    : normalizeAccessTags(source.exemptTags);
  return { enabled: source.enabled === true, exemptTags };
}

/** True when this key may only call combos under the current settings. */
export function isComboOnlyKey(settings, keyAccessTags) {
  const policy = normalizeComboOnlyRouting(settings?.comboOnlyRouting);
  if (!policy.enabled) return false;
  return !hasAccessTagOverlap(keyAccessTags, policy.exemptTags);
}
