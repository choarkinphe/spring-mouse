/**
 * Claude Desktop (3P gateway) model-discovery helpers.
 *
 * Desktop populates its picker from `GET /v1/models` and lists only ids it
 * recognises as Claude, unless the entry carries `anthropic_family_tier`. An
 * opaque gateway id (a combo name) therefore needs that marker, plus a
 * `display_name` for the label and `is_family_default` to pick the default
 * within a tier. Reference: the "Models" section of
 * https://claude.com/docs/third-party/claude-desktop/gateway.
 *
 * The tier is a client-compatibility hint for the picker bucket — it is NOT a
 * claim about the upstream model's family, capability or context window.
 */

// Picker bucket for the configured default route. The documented tier names are
// `sonnet` and `opus`; `sonnet` is the neutral general-purpose bucket and the
// only value used here, since a bare combo id carries no real tier evidence.
export const CLAUDE_DESKTOP_DEFAULT_TIER = "sonnet";

// Stable placeholder when a combo row has no createdAt, so a Models API entry
// always carries a valid ISO timestamp.
export const CLAUDE_DESKTOP_FALLBACK_CREATED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Wrap a model list in the Anthropic Models API list envelope. Desktop reads
 * `data`; has_more/first_id/last_id keep the envelope valid for other
 * Anthropic-compatible clients.
 */
export function buildAnthropicModelsEnvelope(models) {
  const data = Array.isArray(models) ? models : [];
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}
