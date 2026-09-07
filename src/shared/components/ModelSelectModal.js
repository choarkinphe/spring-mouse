"use client";

import { useState, useMemo, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Drawer from "./Drawer";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, getProviderAlias, supportsLiveModelSync } from "@/shared/constants/providers";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter(id => FREE_PROVIDERS[id].noAuth);
const EMPTY_PROVIDERS = [];

export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  selectedModel,
  activeProviders = EMPTY_PROVIDERS,
  title = "Select Model",
  modelAliases = {},
  kindFilter = null,
  capFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
  presentation = "modal",
  drawerWidth = "lg",
}) {
  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState("");
  const [combos, setCombos] = useState([]);
  const [providerConnections, setProviderConnections] = useState(activeProviders);
  const [providerNodes, setProviderNodes] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [disabledModels, setDisabledModels] = useState({});
  const [liveModelsByProvider, setLiveModelsByProvider] = useState({});
  const [isRefreshingCatalog, setIsRefreshingCatalog] = useState(false);

  // Filter active providers by serviceKinds when kindFilter set (e.g. "webSearch", "webFetch").
  // The selector owns a refreshed copy so a long-lived routing page cannot keep stale connections.
  const filteredActiveProviders = useMemo(() => {
    if (!kindFilter) return providerConnections;
    return providerConnections.filter((p) => {
      const info = AI_PROVIDERS[p.provider];
      const kinds = info?.serviceKinds || ["llm"];
      return kinds.includes(kindFilter);
    });
  }, [providerConnections, kindFilter]);

  const handleClose = () => {
    onClose();
    setSearchQuery("");
  };
  const SelectionSurface = presentation === "drawer" ? Drawer : Modal;
  const selectionSurfaceProps = presentation === "drawer"
    ? { isOpen, onClose: handleClose, title, width: drawerWidth }
    : { isOpen, onClose: handleClose, title, size: "md", className: "p-4!", footer: null };

  useEffect(() => {
    if (!isOpen) return undefined;

    let cancelled = false;

    Promise.resolve().then(async () => {
      if (!cancelled) {
        setIsRefreshingCatalog(true);
        setLiveModelsByProvider({});
      }

      const requestJson = async (url) => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        return response.json();
      };

      const [providersResult, combosResult, nodesResult, customResult, disabledResult] = await Promise.allSettled([
        requestJson("/api/providers"),
        requestJson("/api/combos"),
        requestJson("/api/provider-nodes"),
        requestJson("/api/models/custom"),
        requestJson("/api/models/disabled"),
      ]);

      if (cancelled) return;

      const connections = providersResult.status === "fulfilled"
        ? providersResult.value.connections || []
        : activeProviders;
      setProviderConnections(connections);
      setCombos(combosResult.status === "fulfilled" ? combosResult.value.combos || [] : []);
      setProviderNodes(nodesResult.status === "fulfilled" ? nodesResult.value.nodes || [] : []);
      setCustomModels(customResult.status === "fulfilled" ? customResult.value.models || [] : []);
      setDisabledModels(disabledResult.status === "fulfilled" ? disabledResult.value.disabled || {} : {});

      const catalogConnections = [];
      const seenProviders = new Set();
      for (const connection of connections) {
        if (!connection?.id || connection.isActive === false || !supportsLiveModelSync(connection.provider)) continue;
        // Cursor entitlements can differ per account; other providers only need one
        // active account to avoid fan-out when many credentials are configured.
        if (connection.provider !== "cursor" && seenProviders.has(connection.provider)) continue;
        seenProviders.add(connection.provider);
        catalogConnections.push(connection);
      }

      const normalizeModels = (models) => {
        const seen = new Set();
        return models.flatMap((model) => {
          const rawId = typeof model === "string"
            ? model
            : model?.id || model?.slug || model?.model || model?.name;
          const id = typeof rawId === "string" ? rawId.replace(/^models\//, "") : rawId;
          if (!id || seen.has(id)) return [];
          seen.add(id);
          return [typeof model === "string" ? { id, name: id } : {
            ...model,
            id,
            name: model.displayName || model.display_name || model.name || id,
          }];
        });
      };

      await Promise.allSettled(catalogConnections.map(async (connection) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(`/api/providers/${connection.id}/models`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) return;
          const data = await response.json();
          const models = normalizeModels(Array.isArray(data.models) ? data.models : []);
          if (cancelled || models.length === 0) return;

          // Publish each successful provider immediately instead of waiting for a
          // slow or unavailable channel to finish. Cursor accounts are merged.
          setLiveModelsByProvider((current) => {
            const merged = [...(current[connection.provider] || []), ...models];
            return {
              ...current,
              [connection.provider]: Array.from(new Map(merged.map((model) => [model.id, model])).values()),
            };
          });
        } finally {
          clearTimeout(timeoutId);
        }
      }));
    }).catch((error) => {
      console.warn("Unable to refresh model selector data:", error);
    }).finally(() => {
      if (!cancelled) setIsRefreshingCatalog(false);
    });

    return () => { cancelled = true; };
  }, [isOpen, activeProviders]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const refreshCustomModels = () => {
      fetch("/api/models/custom", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Failed to fetch custom models: ${response.status}`);
          return response.json();
        })
        .then((data) => setCustomModels(data.models || []))
        .catch((error) => console.warn("Unable to refresh custom models for selector:", error));
    };
    window.addEventListener("customModelChanged", refreshCustomModels);
    return () => window.removeEventListener("customModelChanged", refreshCustomModels);
  }, [isOpen]);

  const allProviders = useMemo(() => ({ ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS }), []);

  // Group models by provider with priority order
  const groupedModels = useMemo(() => {
    const groups = {};

    // Kinds where the provider IS the model (no per-model selection needed)
    const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
    // Kinds that map directly to model.type field
    const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText"]);
    // For these kinds, providers without hardcoded models can still be picked (provider-as-model fallback)
    const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

    // Filter a models[] array by kindFilter (keep only matching kind)
    const filterByKind = (models) => {
      // No kindFilter means the LLM selector. Keep custom models visible because
      // user-added models may have typed capabilities (for example imageToText)
      // while still being valid chat/combo targets.
      if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
      if (!TYPED_KINDS.has(kindFilter)) return models;
      return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
    };

    // Get all active provider IDs from connections (filtered by kindFilter if set)
    const activeConnectionIds = filteredActiveProviders.map(p => p.provider);

    // No-auth providers: filter by kindFilter as well
    const noAuthIds = kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id) => (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter))
      : NO_AUTH_PROVIDER_IDS;

    // Only show connected providers (including both standard and custom)
    const providerIdsToShow = new Set([
      ...activeConnectionIds,  // Only connected providers
      ...noAuthIds,            // No-auth providers (kind-filtered)
    ]);

    // Sort by PROVIDER_ORDER
    const sortedProviderIds = [...providerIdsToShow].sort((a, b) => {
      const indexA = PROVIDER_ORDER.indexOf(a);
      const indexB = PROVIDER_ORDER.indexOf(b);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    sortedProviderIds.forEach((providerId) => {
      const alias = getProviderAlias(providerId);
      const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" };
      const isCustomProvider = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // For provider-as-model kinds (webSearch/webFetch): emit a single entry where value === providerId
      if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
        groups[providerId] = {
          name: providerInfo.name,
          alias,
          color: providerInfo.color,
          models: [{ id: providerId, name: providerInfo.name, value: providerId }],
        };
        return;
      }

      if (providerInfo.passthroughModels) {
        const providerCatalog = liveModelsByProvider[providerId]?.length
          ? liveModelsByProvider[providerId]
          : getModelsByProviderId(providerId);
        const aliasModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${alias}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${alias}/`, ""),
            name: aliasName,
            value: fullModel,
          }));
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${alias}/${m.id}`,
            kind: getModelKind(m),
            isCustom: true,
          }));

        // For typed kinds, only include hardcoded typed models (aliases are typically LLM-only and lack type info)
        let combined = aliasModels;
        if (kindFilter && TYPED_KINDS.has(kindFilter)) {
          const registeredTyped = customRegisteredModels.filter((m) => getModelKind(m) === kindFilter);
          combined = [
            ...registeredTyped,
            ...providerCatalog
            .filter((m) => getModelKind(m) === kindFilter)
            .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
            .filter((m) => !registeredTyped.some((registered) => registered.value === m.value)),
          ];
          // Fallback: provider-as-model when no hardcoded models match (tts/image/webFetch only)
          if (combined.length === 0 && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
            const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
            if (supports) combined = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        } else {
          // LLM/null kind: merge hardcoded models (e.g. mimo-free → mimo-auto) with user-added models
          const registeredLlms = customRegisteredModels.filter((m) => !getModelKind(m) || getModelKind(m) === "llm");
          const seen = new Set([...aliasModels, ...registeredLlms].map((m) => m.value));
          const hardcoded = providerCatalog
            .filter((m) => !getModelKind(m) || getModelKind(m) === "llm")
            .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
            .filter((m) => !seen.has(m.value));
          combined = [...registeredLlms, ...aliasModels.filter((m) => !registeredLlms.some((registered) => registered.value === m.value)), ...hardcoded];
        }

        if (combined.length > 0) {
          // Check for custom name from providerNodes (for compatible providers)
          const matchedNode = providerNodes.find(node => node.id === providerId);
          const displayName = matchedNode?.name || providerInfo.name;

          groups[providerId] = {
            name: displayName,
            alias: alias,
            color: providerInfo.color,
            models: combined,
          };
        }
      } else if (isCustomProvider) {
        // Custom (openai/anthropic-compatible) providers are LLM-only — skip for typed media kinds
        if (kindFilter && TYPED_KINDS.has(kindFilter)) return;
        // Find connection object to get prefix synchronously without waiting for providerNodes fetch
        const connection = providerConnections.find(p => p.provider === providerId);
        const matchedNode = providerNodes.find(node => node.id === providerId);
        const displayName = matchedNode?.name || connection?.name || providerInfo.name;
        const nodePrefix = connection?.providerSpecificData?.prefix || matchedNode?.prefix || providerId;

        // Aliases are stored using the raw providerId as key (e.g. "openai-compatible-chat-<uuid>/glm-4.7"),
        // so we must filter by providerId, not by the display prefix.
        const nodeModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${providerId}/`, ""),
            name: aliasName,
            value: `${nodePrefix}/${fullModel.replace(`${providerId}/`, "")}`,
          }));

        // Merge custom models registered via /api/models/custom for this provider
        // providerAlias in DB uses the raw providerId, not the display prefix
        const liveNodeModels = (liveModelsByProvider[providerId] || []).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          value: `${nodePrefix}/${m.id}`,
          kind: getModelKind(m),
        }));
        const registeredCustom = customModels
          .filter((m) => m.providerAlias === providerId)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${nodePrefix}/${m.id}`,
            kind: getModelKind(m),
            isCustom: true,
          }));
        const seen = new Set();
        const mergedModels = filterByKind([...liveNodeModels, ...nodeModels, ...registeredCustom].filter((m) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return true;
        }));

        // Always show compatible providers that are connected, even with no aliases.
        // When no aliases exist, show a placeholder so users know it's available.
        const modelsToShow = mergedModels.length > 0 ? mergedModels : [{
          id: `__placeholder__${providerId}`,
          name: `${nodePrefix}/model-id`,
          value: `${nodePrefix}/model-id`,
          isPlaceholder: true,
        }];

        groups[providerId] = {
          name: displayName,
          alias: nodePrefix,
          color: providerInfo.color,
          models: modelsToShow,
          isCustom: true,
          hasModels: mergedModels.length > 0,
        };
      } else {
        const hardcodedModels = liveModelsByProvider[providerId]?.length
          ? liveModelsByProvider[providerId]
          : getModelsByProviderId(providerId);
        const hardcodedIds = new Set(hardcodedModels.map((m) => m.id));

        // Custom models: if no hardcoded models (e.g. openrouter), show all aliases for this provider
        // Otherwise only show aliases where aliasName === modelId ("Add Model" button pattern)
        const hasHardcoded = hardcodedModels.length > 0;
        const customAliasModels = Object.entries(modelAliases)
          .filter(([aliasName, fullModel]) =>
            fullModel.startsWith(`${alias}/`) &&
            (hasHardcoded ? aliasName === fullModel.replace(`${alias}/`, "") : true) &&
            !hardcodedIds.has(fullModel.replace(`${alias}/`, ""))
          )
          .map(([aliasName, fullModel]) => {
            const modelId = fullModel.replace(`${alias}/`, "");
            return { id: modelId, name: aliasName, value: fullModel, isCustom: true };
          });

        // Custom models registered via /api/models/custom (provider "Add Model" button)
        const customAliasIds = new Set(customAliasModels.map((m) => m.id));
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias && !hardcodedIds.has(m.id) && !customAliasIds.has(m.id))
          .map((m) => ({ id: m.id, name: m.name || m.id, value: `${alias}/${m.id}`, isCustom: true }));

        const merged = [
          ...hardcodedModels.map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) })),
          ...customAliasModels,
          ...customRegisteredModels,
        ];
        // Dedupe by value (alias may equal hardcoded id, causing React key collision)
        const seen = new Set();
        let allModels = filterByKind(merged.filter((m) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return true;
        }));

        // Provider-as-model fallback: providers that support the kind but have no hardcoded models
        // can still be picked (value = providerAlias). Skips embedding (always needs model).
        if (allModels.length === 0 && kindFilter && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
          const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
          if (supports) {
            allModels = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        }

        if (allModels.length > 0) {
          groups[providerId] = {
            name: providerInfo.name,
            alias: alias,
            color: providerInfo.color,
            models: allModels,
          };
        }
      }
    });

    // Filter out disabled models per provider (disabled keyed by storage alias OR providerId)
    Object.entries(groups).forEach(([providerId, group]) => {
      const aliasKey = getProviderAlias(providerId);
      const disabledIds = new Set([
        ...(disabledModels[aliasKey] || []),
        ...(disabledModels[providerId] || []),
      ]);
      if (disabledIds.size === 0) return;
      group.models = group.models.filter((m) => !disabledIds.has(m.id));
      if (group.models.length === 0) delete groups[providerId];
    });

    return groups;
  }, [filteredActiveProviders, modelAliases, allProviders, providerNodes, customModels, disabledModels, kindFilter, providerConnections, liveModelsByProvider]);

  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo(() => {
    if (kindFilter || capFilter) return [];
    if (!searchQuery.trim()) return combos;
    const query = searchQuery.toLowerCase();
    return combos.filter(c => c.name.toLowerCase().includes(query));
  }, [combos, searchQuery, kindFilter, capFilter]);

  // Filter models by search query
  const filteredGroups = useMemo(() => {
    const sortModels = (models) => {
      const added = models.filter(m => addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
      const rest = models.filter(m => !addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
      return [...added, ...rest];
    };
    const query = searchQuery.trim().toLowerCase();

    const filtered = {};
    Object.entries(groupedModels).forEach(([providerId, group]) => {
      let models = group.models;
      // Filter by input-modality capability (vision/pdf/audioInput/videoInput).
      if (capFilter) {
        models = models.filter((m) => getCaps(m.value)?.[capFilter] === true);
        if (models.length === 0) return;
      }
      if (query) {
        const providerNameMatches = group.name.toLowerCase().includes(query);
        if (!providerNameMatches) {
          models = models.filter(
            (m) =>
              m.name.toLowerCase().includes(query) ||
              m.id.toLowerCase().includes(query)
          );
          if (models.length === 0) return;
        }
      }
      filtered[providerId] = {
        ...group,
        models: sortModels(models),
      };
    });

    return filtered;
  }, [groupedModels, searchQuery, addedModelValues, capFilter, getCaps]);

  const handleSelect = (model) => {
    const value = model?.value || model?.name || model;
    const isAdded = addedModelValues.includes(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };

  const modelChipClass = (selected, placeholder = false) => `
    inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-[9px] border px-2.5 py-1.5
    text-left text-xs font-medium leading-4 transition-all duration-150 ease-out
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/35
    ${placeholder
      ? "border-dashed border-border bg-surface-2/50 text-text-muted italic hover:border-brand-500/35 hover:text-text-main"
      : selected
        ? "border-[#38bdf8]/45 bg-[#38bdf8]/[0.1] text-[#7dd3fc] shadow-[inset_0_0_0_1px_rgba(56,189,248,0.08)]"
        : "border-border-subtle bg-black/[0.04] text-text-main hover:border-[#38bdf8]/30 hover:bg-[#38bdf8]/[0.05] dark:bg-black/[0.12]"
    }
  `;

  const SelectedMark = () => (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[#38bdf8]/15 text-[#7dd3fc]">
      <span className="material-symbols-outlined text-[11px] font-semibold leading-none">check</span>
    </span>
  );

  return (
    <SelectionSurface {...selectionSurfaceProps}>
      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/[0.045] px-3 py-2.5 text-xs text-text-muted">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-[#38bdf8]/10 text-[#7dd3fc]">
          <span className="material-symbols-outlined text-[15px]">info</span>
        </span>
        <span className="min-w-0 flex-1 leading-5">Click to add, click again to remove. Changes are saved automatically.</span>
        {isRefreshingCatalog && (
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[10px] text-[#7dd3fc]" title="Refreshing provider model catalogs">
            <span className="material-symbols-outlined animate-spin text-[13px]">progress_activity</span>
            Syncing
          </span>
        )}
      </div>

      <div className="relative mb-4">
        <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">search</span>
        <input
          type="text"
          placeholder="Search models or providers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-10 w-full rounded-[10px] border border-transparent bg-surface-2 pl-10 pr-3 text-sm text-text-main outline-none transition-all placeholder:text-text-muted/70 focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/25"
        />
      </div>

      <div className={presentation === "drawer"
        ? "min-w-0 space-y-5 overflow-x-hidden pb-2"
        : "max-h-[min(62vh,520px)] min-w-0 space-y-4 overflow-x-hidden overflow-y-auto pr-1 custom-scrollbar"
      }>
        {filteredCombos.length > 0 && (
          <section>
            <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 border-b border-border-subtle bg-surface/95 pb-2 backdrop-blur-sm">
              <span className="flex size-7 items-center justify-center rounded-lg bg-[#38bdf8]/10 text-[#7dd3fc]">
                <span className="material-symbols-outlined text-[17px]">layers</span>
              </span>
              <span className="text-xs font-semibold text-text-main">Combos</span>
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">{filteredCombos.length}</span>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              {filteredCombos.map((combo) => {
                const isAdded = addedModelValues.includes(combo.name);
                const isSelected = selectedModel === combo.name || isAdded;
                return (
                  <button
                    key={combo.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleSelect({ id: combo.name, name: combo.name, value: combo.name })}
                    className={modelChipClass(isSelected)}
                  >
                    {isSelected && <SelectedMark />}
                    <span className="min-w-0 break-words">{combo.name}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {Object.entries(filteredGroups).map(([providerId, group]) => (
          <section key={providerId} className="min-w-0">
            <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 border-b border-border-subtle bg-surface/95 pb-2 backdrop-blur-sm">
              <span className="flex size-7 items-center justify-center overflow-hidden rounded-lg border border-border-subtle bg-surface-2">
                <ProviderIcon
                  src={`/providers/${providerId}.png`}
                  alt={group.name}
                  size={16}
                  fallbackText={(group.name || providerId).slice(0, 2).toUpperCase()}
                  fallbackColor={group.color}
                />
              </span>
              <span className="min-w-0 truncate text-xs font-semibold text-text-main">{group.name}</span>
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">{group.models.length}</span>
            </div>

            <div className="flex min-w-0 flex-wrap gap-2">
              {group.models.map((model) => {
                const isPlaceholder = model.isPlaceholder;
                const isAdded = addedModelValues.includes(model.value);
                const isSelected = selectedModel === model.value || isAdded;
                return (
                  <button
                    key={model.value}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleSelect(model)}
                    title={isPlaceholder ? "Select to pre-fill, then edit model ID in the input" : model.name}
                    className={modelChipClass(isSelected, isPlaceholder)}
                  >
                    {isSelected && !isPlaceholder && <SelectedMark />}
                    {isPlaceholder ? (
                      <>
                        <span className="material-symbols-outlined shrink-0 text-[14px]">edit</span>
                        <span className="min-w-0 break-words">{model.name}</span>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 break-words">{model.name}</span>
                        {model.isCustom && (
                          <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[9px] font-normal text-text-muted">custom</span>
                        )}
                        <span className="shrink-0"><CapacityBadges caps={getCaps(model.value)} /></span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (
          <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface-2/40 px-4 py-8 text-center text-text-muted">
            <span className="material-symbols-outlined mb-2 text-3xl">search_off</span>
            <p className="text-sm font-medium text-text-main">No models found</p>
            <p className="mt-1 text-xs">Try another model name or provider.</p>
          </div>
        )}
      </div>
    </SelectionSurface>
  );
}

ModelSelectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onDeselect: PropTypes.func,
  selectedModel: PropTypes.string,
  activeProviders: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string.isRequired,
    })
  ),
  title: PropTypes.string,
  modelAliases: PropTypes.object,
  kindFilter: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  closeOnSelect: PropTypes.bool,
  presentation: PropTypes.oneOf(["modal", "drawer"]),
  drawerWidth: PropTypes.oneOf(["sm", "md", "lg", "xl", "2xl", "full"]),
};
