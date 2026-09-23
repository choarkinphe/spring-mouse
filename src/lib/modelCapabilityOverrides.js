import { getCustomModels, getProviderNodes, getProviderConnections } from "@/lib/localDb";
import { replaceModelCapabilityOverrides } from "open-sse/providers/capabilities.js";
import { resolveProviderAliases } from "@/shared/utils/providerCustomModels";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";

const REFRESH_INTERVAL_MS = 30_000;
let loadedAt = 0;
let inflight = null;

/**
 * Display prefix per channel id (`千问API` for a compatible node).
 *
 * A channel's model rows are keyed by its provider id, but combos and the model
 * picker address the same model by the channel's display prefix. Both forms have
 * to resolve to the same overrides or a model the user marked vision-capable
 * reads as text-only when reached through a combo string.
 */
async function collectChannelPrefixes() {
  const prefixes = new Map();
  const [nodes, connections] = await Promise.all([
    getProviderNodes().catch(() => []),
    getProviderConnections().catch(() => []),
  ]);
  for (const node of nodes || []) {
    if (node?.id && node.prefix) prefixes.set(node.id, node.prefix);
  }
  for (const connection of connections || []) {
    const prefix = connection?.providerSpecificData?.prefix;
    if (connection?.provider && prefix && !prefixes.has(connection.provider)) {
      prefixes.set(connection.provider, prefix);
    }
  }
  return prefixes;
}

// A prefix that shadows a built-in provider is skipped: the router refuses to let
// user prefixes override built-in ids/aliases, and registering one here would
// leak a channel's capabilities onto the built-in provider of the same name.
function isBuiltInProviderPrefix(prefix) {
  return Boolean(AI_PROVIDERS[prefix] || ALIAS_TO_ID[prefix]);
}

export async function refreshModelCapabilityOverrides({ force = false } = {}) {
  if (!force && loadedAt > 0 && Date.now() - loadedAt < REFRESH_INTERVAL_MS) return;
  if (inflight) return inflight;

  inflight = Promise.all([getCustomModels(), collectChannelPrefixes()])
    .then(([models, channelPrefixes]) => {
      const entries = [];
      for (const model of models || []) {
        if (!model?.id || !model?.capabilities) continue;
        const providers = new Set();
        for (const id of [model.providerAlias, model.providerId]) {
          if (!id) continue;
          const prefix = channelPrefixes.get(id);
          for (const alias of resolveProviderAliases(id, {
            prefix: prefix && !isBuiltInProviderPrefix(prefix) ? prefix : undefined,
          })) {
            providers.add(alias);
          }
        }
        for (const provider of providers) {
          entries.push({ provider, model: model.id, capabilities: model.capabilities });
        }
      }
      replaceModelCapabilityOverrides(entries);
      loadedAt = Date.now();
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
