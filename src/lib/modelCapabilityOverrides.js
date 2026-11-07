import { getCustomModels, getProviderNodes, getProviderConnections } from "@/lib/localDb";
import { replaceModelCapabilityOverrides, replaceMeasuredCapabilityOverrides } from "open-sse/providers/capabilities.js";
import { getModelCapabilityTests } from "@/lib/db/repos/modelCapabilityTestsRepo.js";
import { capabilityFingerprint, currentEvidence, evidenceCapabilities, manualCapabilities } from "@/lib/modelCapabilities/evidence.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers";
import { resolveProviderAliases } from "@/shared/utils/providerCustomModels";
import { fetchModelsDevCatalog, lookupModelInCatalog } from "@/shared/utils/modelCatalog";
import { AI_PROVIDERS, ALIAS_TO_ID, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";

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
  if (inflight) {
    await inflight;
    if (!force) return;
  }

  inflight = Promise.all([
    getCustomModels(),
    collectChannelPrefixes(),
    getModelCapabilityTests(),
    getProviderConnections(),
  ])
    .then(async ([models, channelPrefixes, profiles, accounts]) => {
      // Only worth fetching the shared catalog when a COMPATIBLE channel has a
      // synced row still lacking capability metadata — registry providers have
      // their own metadata paths and every refresh would pay a remote fetch.
      const needsEnrichment = (models || []).some((model) => model?.id
        && !(model.capabilities || model.manualCapabilities || model.declaredCapabilities)
        && [model.providerAlias, model.providerId].some((id) =>
          isOpenAICompatibleProvider(id) || isAnthropicCompatibleProvider(id) || isCustomEmbeddingProvider(id)));
      const catalogPayload = needsEnrichment ? await fetchModelsDevCatalog().catch(() => null) : null;
      const aliasesFor = (id) => resolveProviderAliases(id, {
        prefix: channelPrefixes.get(id) && !isBuiltInProviderPrefix(channelPrefixes.get(id)) ? channelPrefixes.get(id) : undefined,
      });
      const connections = [];
      const groups = new Map();
      for (const profile of profiles) {
        const account = accounts.find((item) => item.id === profile.connectionId && item.provider === profile.providerId)
          || (profile.connectionId === "noauth" && FREE_PROVIDERS[profile.providerId]?.noAuth ? { id: "noauth", provider: profile.providerId } : null);
        if (!account || account.isActive === false) continue;
        const caps = evidenceCapabilities(currentEvidence(profile, capabilityFingerprint(account, profile.modelId)));
        for (const provider of aliasesFor(profile.providerId)) connections.push({ provider, model: profile.modelId, connectionId: profile.connectionId, capabilities: caps });
        const key = JSON.stringify([profile.providerId, profile.modelId]);
        const group = groups.get(key) || { providerId: profile.providerId, model: profile.modelId, byAccount: new Map() };
        group.byAccount.set(profile.connectionId, caps);
        groups.set(key, group);
      }
      const channels = [];
      for (const group of groups.values()) {
        const active = accounts.filter((item) => item.provider === group.providerId && item.isActive !== false).map((item) => item.id);
        if (FREE_PROVIDERS[group.providerId]?.noAuth) active.push("noauth");
        const caps = {};
        const keys = new Set([...group.byAccount.values()].flatMap((item) => Object.keys(item)));
        for (const key of keys) {
          const values = active.map((id) => group.byAccount.get(id)?.[key]);
          if (values.some((value) => value === true)) caps[key] = true;
          else if (values.length && values.every((value) => value === false)) caps[key] = false;
          else if (values.length && values.every((value) => Number.isFinite(value))) caps[key] = Math.max(...values);
        }
        for (const provider of aliasesFor(group.providerId)) channels.push({ provider, model: group.model, capabilities: caps });
      }
      const entries = [];
      const manual = [];
      for (const model of models || []) {
        if (!model?.id) continue;
        const hasStored = model.capabilities || model.manualCapabilities || model.declaredCapabilities;
        const isCompatibleChannelRow = [model.providerAlias, model.providerId].some((id) =>
          isOpenAICompatibleProvider(id) || isAnthropicCompatibleProvider(id) || isCustomEmbeddingProvider(id));
        // Compatible-channel rows synced before capability enrichment (or added
        // by hand) carry no spec sheet — look the id up in the shared catalog so
        // their badges and downstream capability gates stop reading as text-only.
        if (!hasStored && isCompatibleChannelRow && catalogPayload) {
          const entry = lookupModelInCatalog(catalogPayload, model.id, null);
          if (entry?.capabilities && Object.keys(entry.capabilities).length > 0) {
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
              entries.push({ provider, model: model.id, capabilities: entry.capabilities });
            }
            continue;
          }
        }
        if (!hasStored) continue;
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
          entries.push({ provider, model: model.id, capabilities: model.declaredCapabilities || model.capabilities || {} });
          manual.push({ provider, model: model.id, capabilities: manualCapabilities(model) });
        }
      }
      replaceModelCapabilityOverrides(entries);
      replaceMeasuredCapabilityOverrides({ connections, channels, manual });
      loadedAt = Date.now();
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
