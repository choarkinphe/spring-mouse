// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getProviderConnections } from "@/lib/localDb";
import { CODEX_NATIVE_IMAGE_MODEL } from "open-sse/config/codexImage.js";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getActiveComboModelEntries } from "open-sse/services/combo.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      // Performance optimization: Fetch all nodes in a single query instead of 3 separate type-filtered queries
      // Build in-memory index for O(1) prefix lookups instead of repeated array searches
      const allNodes = await getProviderNodes();

      // Build type-based index for faster lookups
      const nodesByType = { "openai-compatible": [], "anthropic-compatible": [], "custom-embedding": [] };
      for (const node of allNodes) {
        if (nodesByType[node.type]) {
          nodesByType[node.type].push(node);
        }
      }

      // Check OpenAI-compatible nodes
      const matchedOpenAI = nodesByType["openai-compatible"].find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      // Check Anthropic-compatible nodes
      const matchedAnthropic = nodesByType["anthropic-compatible"].find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      // Check custom-embedding nodes
      const matchedEmbedding = nodesByType["custom-embedding"].find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo && combo.isActive !== false) {
    // Return an explicit combo source so same-name combo targets remain visible
    // in usage routing metadata.
    return { provider: null, model: parsed.model, routeKind: "combo", routed: true };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * The native Codex image tool sends a bare protocol ID, not a catalog choice.
 * Resolve explicit operator aliases/combos first; only replace name inference
 * in the Images API context when an enabled Codex channel actually exists.
 * Explicit openai/... routes and chat model inference are never changed.
 */
export async function getImageModelInfo(modelStr) {
  const info = await getModelInfo(modelStr);
  if (modelStr !== CODEX_NATIVE_IMAGE_MODEL || info.routeKind) return info;
  const connections = await getProviderConnections({ provider: "codex", isActive: true });
  return connections.some((connection) => connection.provider === "codex" && connection.isActive !== false)
    ? { provider: "codex", model: CODEX_NATIVE_IMAGE_MODEL }
    : info;
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModelEntries(modelStr, accessTags) {
  if (modelStr.includes("/")) return null;
  const combo = await getComboByName(modelStr);
  if (combo && combo.isActive !== false && combo.models && combo.models.length > 0) {
    return getActiveComboModelEntries(combo.models, new Date(), Array.isArray(accessTags) ? accessTags : undefined);
  }
  return null;
}

export async function getComboModels(modelStr, accessTags) {
  const entries = await getComboModelEntries(modelStr, accessTags);
  return entries?.map((entry) => entry.model) ?? null;
}
