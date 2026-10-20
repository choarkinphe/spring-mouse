// Browser-safe binding contract shared by the management API, UI and gateway.
import REGISTRY from "../providers/registry/index.js";
import { createComboCapabilityResolver } from "./comboCapabilities.js";

export const COMBO_SEARCH_MODE = "gateway";
export const COMBO_SEARCH_MAX_RESULTS = 5;

// Canonical dedicated search providers only: chat-backed search and combo names
// are deliberately not eligible for a gateway search binding.
export function getComboSearchProviders() {
  return REGISTRY.filter((provider) => provider.searchConfig || provider.media?.searchConfig)
    .map((provider) => ({ id: provider.id, name: provider.display?.name || provider.id }));
}

/** null disables search; undefined signals an invalid configuration. */
export function normalizeComboSearch(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !["mode", "provider", "maxResults"].includes(key))) return undefined;
  if (value.mode !== COMBO_SEARCH_MODE) return undefined;
  if (!getComboSearchProviders().some(({ id }) => id === value.provider)) return undefined;
  if (value.maxResults !== undefined && value.maxResults !== COMBO_SEARCH_MAX_RESULTS) return undefined;
  return { mode: COMBO_SEARCH_MODE, provider: value.provider, maxResults: COMBO_SEARCH_MAX_RESULTS };
}

export function getComboSearchValidationError(search, options = {}) {
  const normalized = normalizeComboSearch(search);
  if (normalized === undefined) return "Invalid combo search: choose gateway mode and a dedicated search provider (maxResults: 5)";
  if (normalized === null) return null;
  if (options.kind && options.kind !== "llm") return "Search binding is only supported for LLM combos";
  const resolver = createComboCapabilityResolver(options);
  if (!(options.models || []).some((entry) => resolver.supports(entry, ["tools"], ["tools"]))) {
    return "Gateway search requires at least one reachable tools-capable model";
  }
  return null;
}
