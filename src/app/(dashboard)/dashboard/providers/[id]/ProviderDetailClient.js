"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { normalizeCustomChannelIconSrc } from "@/shared/constants/customChannelIcons";
import { AccessTagsEditor, Card, Button, Modal, CardSkeleton, ConfirmModal, ModelCapabilitiesModal } from "@/shared/components";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, supportsLiveModelSync, AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { translate } from "@/i18n/runtime";
import { fetchSuggestedModels } from "@/shared/utils/providerModelsFetcher";
import { describeModelSource, getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { hasModelsDevCatalog } from "@/shared/utils/modelCatalog";
import ModelRow from "./ModelRow";
import PassthroughModelsSection from "./PassthroughModelsSection";
import CompatibleModelsSection from "./CompatibleModelsSection";
import EditCompatibleNodeIconModal from "./EditCompatibleNodeIconModal";
import AddCustomModelModal from "./AddCustomModelModal";

// Chinese labels for thinking levels ("auto" = no suffix appended when copying model names).
const THINKING_LEVEL_LABELS = {
  auto: "自动",
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极致",
  thinking: "思考",
};
const thinkingLevelLabel = (level) => THINKING_LEVEL_LABELS[level] || level;

export default function ProviderDetailClient({ providerId: providerIdOverride, embedded = false, onClose, onUpdated }) {
  const params = useParams();
  const providerId = providerIdOverride || params.id;
  const { getCaps } = useModelCaps();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [providerNode, setProviderNode] = useState(null);
  const [showEditNodeIconModal, setShowEditNodeIconModal] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [headerImgError, setHeaderImgError] = useState(false);
  const [modelTestResults, setModelTestResults] = useState({});
  const [modelsTestError, setModelsTestError] = useState("");
  const [testingModelIds, setTestingModelIds] = useState(() => new Set());
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const [capabilitiesModel, setCapabilitiesModel] = useState(null);
  const [savingCapabilities, setSavingCapabilities] = useState(false);
  const [togglingCapability, setTogglingCapability] = useState(null);
  const [thinkingMode, setThinkingMode] = useState("auto");
  const [suggestedModels, setSuggestedModels] = useState([]);
  const [liveModels, setLiveModels] = useState([]);
  const [kiloFreeModels, setKiloFreeModels] = useState([]);
  const [disabledModelIds, setDisabledModelIds] = useState([]);
  const [modelAccessTags, setModelAccessTags] = useState({});
  const [taggingModel, setTaggingModel] = useState(null);
  const [modelTagDraft, setModelTagDraft] = useState([]);
  const [savingModelTags, setSavingModelTags] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [importingQoderModels, setImportingQoderModels] = useState(false);
  const [syncingModels, setSyncingModels] = useState(false);
  const [modelSyncStatus, setModelSyncStatus] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  const providerInfo = providerNode
    ? {
        id: providerNode.id,
        name: providerNode.name || (providerNode.type === "anthropic-compatible" ? "Anthropic Compatible" : "OpenAI Compatible"),
        color: providerNode.type === "anthropic-compatible" ? "#D97757" : "#10A37F",
        textIcon: providerNode.type === "anthropic-compatible" ? "AC" : "OC",
        apiType: providerNode.apiType,
        baseUrl: providerNode.baseUrl,
        type: providerNode.type,
      }
    : (OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId] || FREE_PROVIDERS[providerId] || FREE_TIER_PROVIDERS[providerId] || WEB_COOKIE_PROVIDERS[providerId]);
  const isFreeNoAuth = !!FREE_PROVIDERS[providerId]?.noAuth;
  const staticModels = getModelsByProviderId(providerId);
  const models = providerId === "cursor" && liveModels.length > 0
    ? liveModels
    : staticModels;
  const providerAlias = getProviderAlias(providerId);

  const isOpenAICompatible = isOpenAICompatibleProvider(providerId);
  const isAnthropicCompatible = isAnthropicCompatibleProvider(providerId);
  const isCompatible = isOpenAICompatible || isAnthropicCompatible;
  // Resolve suffix "(level)" for a model when a thinking level is picked and the model supports it.
  const resolveThinkingSuffix = (modelId) => {
    if (!thinkingMode || thinkingMode === "auto") return null;
    const levels = getThinkingLevels(providerId, modelId);
    return levels && levels.includes(thinkingMode) ? thinkingMode : null;
  };
  const providerStorageAlias = isCompatible ? providerId : providerAlias;
  // Channels without a live /models endpoint can still be synced when the shared
  // capability catalog covers them (see MODELS_DEV_PROVIDER_KEYS).
  const supportsModelSync = Boolean(
    providerInfo?.modelCatalog || supportsLiveModelSync(providerId) || hasModelsDevCatalog(providerId)
  );
  // Union of levels across this provider's reasoning models — drives the level picker options.
  // Include custom models too (e.g. manually added gpt-5.6-sol → max).
  const providerThinkingLevels = (() => {
    const set = new Set();
    const seen = new Set();
    const addLevels = (modelId) => {
      if (!modelId || seen.has(modelId)) return;
      seen.add(modelId);
      const lv = getThinkingLevels(providerId, modelId);
      if (lv) lv.forEach((l) => { if (l !== "none") set.add(l); });
    };
    for (const m of models) addLevels(m.id);
    for (const m of kiloFreeModels) addLevels(m.id);
    for (const entry of customModels) {
      if (entry.providerAlias !== providerStorageAlias) continue;
      if ((entry.kind || entry.type || "llm") !== "llm") continue;
      addLevels(entry.id);
    }
    return set.size ? ["auto", ...[...set]] : null;
  })();
  const providerDisplayAlias = isCompatible
    ? (providerNode?.prefix || providerId)
    : providerAlias;

  const fetchDisabledModels = useCallback(async () => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setDisabledModelIds(data.ids || []);
    } catch (error) {
      console.log("Error fetching disabled models:", error);
    }
  }, [providerStorageAlias]);

  const handleDisableModel = async (modelId) => {
    try {
      const res = await fetch("/api/models/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: providerStorageAlias, ids: [modelId] }),
      });
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error disabling model:", error);
    }
  };

  const handleEnableModel = async (modelId) => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}&id=${encodeURIComponent(modelId)}`, { method: "DELETE" });
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error enabling model:", error);
    }
  };

  const handleDisableAll = async (ids) => {
    if (!ids.length) return;
    setConfirmState({
      title: "Disable All Models",
      message: `Disable all ${ids.length} model(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch("/api/models/disabled", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerAlias: providerStorageAlias, ids }),
          });
          if (res.ok) await fetchDisabledModels();
        } catch (error) {
          console.log("Error disabling all models:", error);
        }
      }
    });
  };

  const handleEnableAll = async () => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}`, { method: "DELETE" });
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error enabling all models:", error);
    }
  };

  // Define callbacks BEFORE the useEffect that uses them
  const fetchAliases = useCallback(async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) {
        setModelAliases(data.aliases || {});
      }
    } catch (error) {
      console.log("Error fetching aliases:", error);
    }
  }, []);

  const fetchCustomModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models/custom", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setCustomModels(data.models || []);
      }
    } catch (error) {
      console.log("Error fetching custom models:", error);
    }
  }, []);

  // Fetch free models from Kilo API for kilocode provider
  useEffect(() => {
    if (providerId !== "kilocode") return;
    fetch("/api/providers/kilo/free-models")
      .then((res) => res.json())
      .then((data) => { if (data.models?.length) setKiloFreeModels(data.models); })
      .catch(() => {});
  }, [providerId]);

  const fetchConnections = useCallback(async () => {
    try {
      const [connectionsRes, nodesRes, settingsRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/provider-nodes", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const connectionsData = await connectionsRes.json();
      const nodesData = await nodesRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      if (connectionsRes.ok) {
        const filtered = (connectionsData.connections || []).filter(c => c.provider === providerId);
        setConnections(filtered);
      }
      // Load per-provider thinking config
      const thinkingCfg = (settingsData.providerThinking || {})[providerId] || {};
      setThinkingMode(thinkingCfg.mode || "auto");
      setModelAccessTags(settingsData.modelAccessTags || {});
      if (nodesRes.ok) {
        let node = (nodesData.nodes || []).find((entry) => entry.id === providerId) || null;

        // Newly created compatible nodes can be briefly unavailable on one worker.
        // Retry a few times before showing "Provider not found".
        if (!node && isCompatible) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            const retryRes = await fetch("/api/provider-nodes", { cache: "no-store" });
            if (!retryRes.ok) continue;
            const retryData = await retryRes.json();
            node = (retryData.nodes || []).find((entry) => entry.id === providerId) || null;
            if (node) break;
          }
        }

        setProviderNode(node);
      }
    } catch (error) {
      console.log("Error fetching connections:", error);
    } finally {
      setLoading(false);
    }
  }, [providerId, isCompatible]);

  const notifyChannelListUpdated = useCallback(async () => {
    await onUpdated?.();
  }, [onUpdated]);

  const handleUpdateNodeIcon = async (icon) => {
    if (!providerNode) return;
    try {
      const res = await fetch(`/api/provider-nodes/${providerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icon }),
      });
      const data = await res.json();
      if (res.ok) {
        setProviderNode(data.node);
        setHeaderImgError(false);
        await fetchConnections();
        await notifyChannelListUpdated();
        setShowEditNodeIconModal(false);
      }
    } catch (error) {
      console.log("Error updating provider node icon:", error);
    }
  };

  const saveThinkingConfig = async (mode) => {
    try {
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const current = settingsData.providerThinking || {};
      const updated = { ...current };
      if (!mode || mode === "auto") {
        delete updated[providerId];
      } else {
        updated[providerId] = { mode };
      }
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerThinking: updated }),
      });
    } catch (error) {
      console.log("Error saving thinking config:", error);
    }
  };

  const handleThinkingModeChange = (mode) => {
    setThinkingMode(mode);
    saveThinkingConfig(mode);
  };

  useEffect(() => {
    fetchConnections();
    fetchAliases();
    fetchCustomModels();
    fetchDisabledModels();
  }, [fetchConnections, fetchAliases, fetchCustomModels, fetchDisabledModels]);

  // Cursor's model availability is account-specific and changes frequently.
  // Load the active account's live catalog for the dashboard; the static
  // registry remains the fallback while the request is pending or unavailable.
  useEffect(() => {
    if (providerId !== "cursor") {
      setLiveModels([]);
      return;
    }

    const connection = connections.find((item) => item.isActive !== false);
    if (!connection?.id) {
      setLiveModels([]);
      return;
    }

    let cancelled = false;
    fetch(`/api/providers/${connection.id}/models`, { cache: "no-store" })
      .then(async (res) => ({ ok: res.ok, data: await res.json() }))
      .then(({ ok, data }) => {
        if (!cancelled && ok && Array.isArray(data.models) && data.models.length > 0) {
          setLiveModels(data.models);
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [providerId, connections]);

  // Fetch suggested models from provider's public API (if configured)
  useEffect(() => {
    const fetcher = (OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId] || FREE_PROVIDERS[providerId] || FREE_TIER_PROVIDERS[providerId])?.modelsFetcher;
    if (!fetcher) return;
    fetchSuggestedModels(fetcher).then(setSuggestedModels);
  }, [providerId]);

  const handleSetAlias = async (modelId, alias, providerAliasOverride = providerAlias) => {
    const fullModel = `${providerAliasOverride}/${modelId}`;
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: fullModel, alias }),
      });
      if (res.ok) {
        await fetchAliases();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to set alias");
      }
    } catch (error) {
      console.log("Error setting alias:", error);
    }
  };

  const handleDeleteAlias = async (alias) => {
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        await fetchAliases();
      }
    } catch (error) {
      console.log("Error deleting alias:", error);
    }
  };

  const handleAddCustomModel = async (modelId, type = "llm", providerAliasOverride = providerStorageAlias) => {
    try {
      const res = await fetch("/api/models/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: providerAliasOverride, id: modelId, type }),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchCustomModels();
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
        return true;
      }
      alert(data.error || "Failed to add custom model");
    } catch (error) {
      console.log("Error adding custom model:", error);
      alert("Failed to add custom model");
    }
    return false;
  };

  const handleDeleteCustomModel = async (modelId, type = "llm", providerAliasOverride = providerStorageAlias) => {
    try {
      const params = new URLSearchParams({ providerAlias: providerAliasOverride, id: modelId, type });
      const res = await fetch(`/api/models/custom?${params}`, { method: "DELETE" });
      if (res.ok) {
        await fetchCustomModels();
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (error) {
      console.log("Error deleting custom model:", error);
    }
  };

  // Capability editor works for built-in registry models too — the API upserts a
  // capability-only override row, so the shared resolver picks it up everywhere.
  const openModelCapabilitiesEditor = (payload) => {
    if (!payload?.id || !payload?.providerAlias) return;
    setCapabilitiesModel({ ...payload, key: `${payload.providerAlias}|${payload.id}` });
  };

  const handleSaveModelCapabilities = async (capabilities) => {
    if (!capabilitiesModel || savingCapabilities) return;
    setSavingCapabilities(true);
    try {
      const res = await fetch("/api/models/custom", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerAlias: capabilitiesModel.providerAlias,
          providerId: capabilitiesModel.providerId || providerId,
          id: capabilitiesModel.id,
          type: "llm",
          capabilities,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || translate("Failed to update model capabilities"));
        return;
      }
      await fetchCustomModels();
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      setCapabilitiesModel(null);
    } catch (error) {
      console.log("Error saving model capabilities:", error);
      alert(translate("Failed to update model capabilities"));
    } finally {
      setSavingCapabilities(false);
    }
  };

  // Raw user overrides (origin = "capability-override") keyed by `${alias}|${id}|${type}`.
  // Card-level toggles rewrite only the capability they touch, so the override row
  // never freezes the whole resolved capability set (built-in defaults keep winning
  // for every capability the user has not explicitly touched).
  const capabilityOverrides = useMemo(() => {
    const map = {};
    for (const m of customModels || []) {
      if (!m?.id || !m?.capabilities || m.origin !== "capability-override") continue;
      map[`${m.providerAlias}|${m.id}|${m.type || "llm"}`] = m.capabilities;
    }
    return map;
  }, [customModels]);

  const handleToggleCapability = async ({ providerAlias, providerId: targetProviderId, id, overrideCaps = {}, key, value }) => {
    if (!providerAlias || !id || !key) return;
    if (togglingCapability) return;
    setTogglingCapability(`${providerAlias}|${id}|${key}`);
    try {
      const res = await fetch("/api/models/custom", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerAlias,
          providerId: targetProviderId || providerId,
          id,
          type: "llm",
          capabilities: { ...overrideCaps, [key]: value },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || translate("Failed to update model capabilities"));
        return;
      }
      await fetchCustomModels();
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
    } catch (error) {
      console.log("Error toggling model capability:", error);
      alert(translate("Failed to update model capabilities"));
    } finally {
      setTogglingCapability(null);
    }
  };

  // Fetch Qoder model list and automatically add to available models
  const handleImportQoderModels = async () => {
    if (importingQoderModels) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) {
      alert(translate("Please add an active Qoder connection first"));
      return;
    }

    setImportingQoderModels(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || translate("Failed to fetch models"));
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert(translate("No models returned"));
        return;
      }

      let importedCount = 0;
      for (const model of models) {
        const modelId = model.id || model.name;
        if (!modelId) continue;

        // Qoder model ID format may be "qoder/auto" or "auto", need to remove prefix
        const cleanModelId = modelId.replace(/^qoder\//, "");
        const alreadyExists = customModels.some(
          (entry) => entry.providerAlias === providerStorageAlias && entry.id === cleanModelId && (entry.kind || entry.type || "llm") === "llm"
        ) || Object.values(modelAliases).includes(`${providerStorageAlias}/${cleanModelId}`);
        if (alreadyExists) {
          continue;
        }

        await handleAddCustomModel(cleanModelId, "llm", providerStorageAlias);
        importedCount += 1;
      }

      if (importedCount === 0) {
        alert(translate("All models already exist, no new models added"));
      } else {
        alert(translate("Successfully added") + ` ${importedCount} ` + translate("models"));
      }
    } catch (error) {
      console.log("Error importing Qoder models:", error);
      alert(translate("Error fetching models") + ": " + error.message);
    } finally {
      setImportingQoderModels(false);
    }
  };

  const handleSyncSupportedModels = async () => {
    if (syncingModels) return;
    const activeConnection = connections.find((connection) => connection.isActive !== false);
    if (!activeConnection) {
      setModelSyncStatus({ type: "error", text: translate("Please add an active connection before syncing models") });
      return;
    }
    setSyncingModels(true);
    setModelSyncStatus(null);
    try {
      // The provider's own /models endpoint is the freshest source but is often
      // partial (or entirely unavailable for the current account). Never abort on
      // it — send what we got and let the backend merge the shared capability
      // catalog so the channel still ends up with the full supported set.
      let officialModels = [];
      let officialWarning = "";
      try {
        const officialRes = await fetch(`/api/providers/${activeConnection.id}/models`, { cache: "no-store" });
        const officialData = await officialRes.json().catch(() => ({}));
        if (officialRes.ok) {
          officialModels = officialData.models || [];
        } else {
          officialWarning = officialData.error || `HTTP ${officialRes.status}`;
        }
      } catch (error) {
        officialWarning = error.message;
      }

      const res = await fetch("/api/providers/model-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, supportedModels: officialModels }),
      });
      const data = await res.json();
      if (!res.ok) {
        setModelSyncStatus({ type: "error", text: data.error || translate("Failed to sync supported models") });
        return;
      }

      await fetchCustomModels();
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      const detail = `官方 ${data.officialCount ?? officialModels.length} · 目录 ${data.catalogCount ?? 0}`;
      setModelSyncStatus({
        type: "success",
        text: `${translate("Model synchronization complete")}: ${data.total} ${translate("models")} (${detail}), ${data.added} ${translate("added")}, ${data.updated} ${translate("updated")}`
          + (officialWarning ? ` · 官方接口不可用（${officialWarning}），已用能力目录补齐` : ""),
      });
    } catch (error) {
      setModelSyncStatus({ type: "error", text: `${translate("Failed to sync supported models")}: ${error.message}` });
    } finally {
      setSyncingModels(false);
    }
  };


  const handleTestModel = async (modelId) => {
    if (testingModelIds.has(modelId)) return;
    setTestingModelIds((prev) => new Set(prev).add(modelId));
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
      setModelsTestError(data.ok ? "" : (data.error || "Model not reachable"));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      setModelsTestError("Network error");
    } finally {
      setTestingModelIds((prev) => { const n = new Set(prev); n.delete(modelId); return n; });
    }
  };

  const openModelTagEditor = (modelId) => {
    setTaggingModel(modelId);
    setModelTagDraft(modelAccessTags[modelId] || []);
  };

  const saveModelTags = async () => {
    if (!taggingModel) return;
    const next = { ...modelAccessTags };
    if (modelTagDraft.length > 0) next[taggingModel] = modelTagDraft;
    else delete next[taggingModel];
    setSavingModelTags(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelAccessTags: next }),
      });
      if (response.ok) {
        setModelAccessTags(next);
        setTaggingModel(null);
      }
    } finally {
      setSavingModelTags(false);
    }
  };

  const renderModelsSection = () => {
    if (isCompatible) {
      return (
        <CompatibleModelsSection
          providerStorageAlias={providerStorageAlias}
          providerDisplayAlias={providerDisplayAlias}
          modelAliases={modelAliases}
          customModels={customModels}
          copied={copied}
          onCopy={copy}
          onSetAlias={handleSetAlias}
          onDeleteAlias={handleDeleteAlias}
          onAddCustomModel={(modelId) => handleAddCustomModel(modelId, "llm", providerStorageAlias)}
          onDeleteCustomModel={(modelId) => handleDeleteCustomModel(modelId, "llm", providerStorageAlias)}
          onDisableModel={handleDisableModel}
          onEnableModel={handleEnableModel}
          disabledModelIds={disabledModelIds}
          connections={connections}
          getCaps={getCaps}
          isAnthropic={isAnthropicCompatible}
          modelAccessTags={modelAccessTags}
          onEditAccessTags={openModelTagEditor}
          onEditCapabilities={openModelCapabilitiesEditor}
          onToggleCapability={handleToggleCapability}
          capabilityOverrides={capabilityOverrides}
          togglingCapability={togglingCapability}
        />
      );
    }
    // Combine hardcoded models with Kilo free models (deduplicated)
    // Exclude non-llm models (embedding, tts, etc.) — they have dedicated pages under media-providers
    const allModels = [
      ...models,
      ...kiloFreeModels.filter((fm) => !models.some((m) => m.id === fm.id)),
    ].filter((m) => { const k = getModelKind(m); return !k || k === "llm"; });
    const disabledSet = new Set(disabledModelIds);
    const displayModels = allModels.filter((m) => !disabledSet.has(m.id));
    const disabledDisplayModels = allModels.filter((m) => disabledSet.has(m.id));
    const customModelRows = getProviderCustomModelRows({
      customModels,
      modelAliases,
      providerAlias: providerStorageAlias,
      builtInModels: models,
      type: "llm",
    });

    return (
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {/* Custom models first */}
        {customModelRows.map((model) => {
          const rowCaps = { ...(getCaps(`${providerStorageAlias}/${model.id}`) || {}), ...(model.capabilities || {}) };
          const rowOverrideCaps = model.capabilities || capabilityOverrides[`${providerStorageAlias}|${model.id}|llm`] || {};
          const rowBusyPrefix = `${providerStorageAlias}|${model.id}|`;
          const rowBusyCapabilityKey = togglingCapability?.startsWith(rowBusyPrefix)
            ? togglingCapability.slice(rowBusyPrefix.length)
            : null;
          return (
            <ModelRow
              key={`${model.source}-${model.fullModel}`}
              model={{ id: model.id, name: model.name }}
              fullModel={`${providerDisplayAlias}/${model.id}`}
              alias={model.alias}
              copied={copied}
              onCopy={copy}
              onSetAlias={() => {}}
              onDeleteAlias={() => {
                if (model.source === "custom") {
                  handleDeleteCustomModel(model.id, "llm", providerStorageAlias);
                } else {
                  handleDeleteAlias(model.alias);
                }
              }}
              testStatus={modelTestResults[model.id]}
              onTest={connections.length > 0 || isFreeNoAuth ? () => handleTestModel(model.id) : undefined}
              isTesting={testingModelIds.has(model.id)}
              isCustom
              isFree={false}
              sourceLabel={describeModelSource(model.modelSource)}
              caps={rowCaps}
              thinkingSuffix={resolveThinkingSuffix(model.id)}
              accessTags={modelAccessTags[`${providerStorageAlias}/${model.id}`] || []}
              onEditAccessTags={() => openModelTagEditor(`${providerStorageAlias}/${model.id}`)}
              onEditCapabilities={() => openModelCapabilitiesEditor({
                id: model.id,
                providerAlias: providerStorageAlias,
                providerId: model.providerId || providerId,
                fullModel: `${providerDisplayAlias}/${model.id}`,
                caps: rowCaps,
              })}
              onToggleCapability={(key, value) => handleToggleCapability({
                providerAlias: providerStorageAlias,
                providerId: model.providerId || providerId,
                id: model.id,
                overrideCaps: rowOverrideCaps,
                key,
                value,
              })}
              busyCapabilityKey={rowBusyCapabilityKey}
            />
          );
        })}

        {displayModels.map((model) => {
          const fullModel = `${providerStorageAlias}/${model.id}`;
          const oldFormatModel = `${providerId}/${model.id}`;
          const existingAlias = Object.entries(modelAliases).find(
            ([, m]) => m === fullModel || m === oldFormatModel
          )?.[0];
          const builtInCaps = getCaps(`${providerId}/${model.id}`) || {};
          const builtInOverrideCaps = capabilityOverrides[`${providerStorageAlias}|${model.id}|llm`] || {};
          const builtInBusyPrefix = `${providerStorageAlias}|${model.id}|`;
          const builtInBusyCapabilityKey = togglingCapability?.startsWith(builtInBusyPrefix)
            ? togglingCapability.slice(builtInBusyPrefix.length)
            : null;
          return (
            <ModelRow
              key={model.id}
              model={model}
              fullModel={`${providerDisplayAlias}/${model.id}`}
              alias={existingAlias}
              copied={copied}
              onCopy={copy}
              onSetAlias={(alias) => handleSetAlias(model.id, alias, providerStorageAlias)}
              onDeleteAlias={() => handleDeleteAlias(existingAlias)}
              testStatus={modelTestResults[model.id]}
              onTest={connections.length > 0 || isFreeNoAuth ? () => handleTestModel(model.id) : undefined}
              isTesting={testingModelIds.has(model.id)}
              isFree={model.isFree}
              onDisable={() => handleDisableModel(model.id)}
              caps={builtInCaps}
              thinkingSuffix={resolveThinkingSuffix(model.id)}
              accessTags={modelAccessTags[`${providerStorageAlias}/${model.id}`] || []}
              onEditAccessTags={() => openModelTagEditor(`${providerStorageAlias}/${model.id}`)}
              onEditCapabilities={() => openModelCapabilitiesEditor({
                id: model.id,
                providerAlias: providerStorageAlias,
                providerId,
                fullModel: `${providerDisplayAlias}/${model.id}`,
                caps: builtInCaps,
              })}
              onToggleCapability={(key, value) => handleToggleCapability({
                providerAlias: providerStorageAlias,
                providerId,
                id: model.id,
                overrideCaps: builtInOverrideCaps,
                key,
                value,
              })}
              busyCapabilityKey={builtInBusyCapabilityKey}
            />
          );
        })}

        {/* Add model button — inline, same style as model chips */}
        <button
          type="button"
          onClick={() => setShowAddCustomModel(true)}
          className="flex min-h-[116px] w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-2/40 px-4 py-3 text-sm font-semibold text-text-muted transition-colors hover:border-primary/50 hover:bg-primary/[0.05] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          添加模型
        </button>

        {/* Import Qoder models button — only show for qoder provider */}
        {providerId === "qoder" && connections.some((conn) => conn.isActive !== false) && (
          <button
            type="button"
            onClick={handleImportQoderModels}
            disabled={importingQoderModels}
            className="flex min-h-[116px] w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-2/40 px-4 py-3 text-sm font-semibold text-text-muted transition-colors hover:border-primary/50 hover:bg-primary/[0.05] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]" style={importingQoderModels ? { animation: "spin 1s linear infinite" } : undefined}>
              {importingQoderModels ? "progress_activity" : "download"}
            </span>
            {importingQoderModels ? translate("Fetching...") : translate("Fetch Qoder Models")}
          </button>
        )}

        {/* Suggested models from provider API — show only models not yet added */}
        {suggestedModels.length > 0 && (() => {
          const addedFullModels = new Set([
            ...Object.values(modelAliases),
            ...customModelRows.map((model) => model.fullModel),
          ]);
          const hardcodedIds = new Set(models.map((m) => m.id));
          const notAdded = suggestedModels.filter(
            (m) => !addedFullModels.has(`${providerStorageAlias}/${m.id}`) && !hardcodedIds.has(m.id)
          );
          if (notAdded.length === 0) return null;
          return (
            <div className="mt-2 w-full md:col-span-3">
              <p className="text-xs text-text-muted mb-2">Suggested free models (≥200k context):</p>
              <div className="flex flex-wrap gap-2">
                {notAdded.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={async () => {
                      await handleAddCustomModel(m.id, "llm", providerStorageAlias);
                    }}
                    className="inline-flex items-center gap-1 rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary"
                    title={`${m.name} · ${(m.contextLength / 1000).toFixed(0)}k ctx`}
                  >
                    <span className="material-symbols-outlined text-[14px]">add</span>
                    {m.id.split("/").pop()}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Disabled models — restorable */}
        {disabledDisplayModels.length > 0 && (
          <div className="mt-2 w-full md:col-span-3">
            <p className="text-xs text-text-muted mb-2">Disabled models ({disabledDisplayModels.length}):</p>
            <div className="flex flex-wrap gap-2">
              {disabledDisplayModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleEnableModel(m.id)}
                  className="inline-flex items-center gap-1 rounded-[8px] border border-dashed border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary"
                  title="Restore model"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span>
                  {m.id}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
}

  if (!providerInfo) {
    return (
      <div className="text-center py-20">
        <p className="text-text-muted">Provider not found</p>
        {embedded ? (
          <button type="button" onClick={onClose} className="text-primary mt-4 inline-block">Close</button>
        ) : (
          <Link href="/dashboard/providers" className="text-primary mt-4 inline-block">
            Back to Providers
          </Link>
        )}
      </div>
    );
  }

  // Determine icon path: OpenAI Compatible providers use specialized icons
  const getHeaderIconPath = () => {
    if (isCompatible && providerNode?.icon) {
      return normalizeCustomChannelIconSrc(providerNode.icon);
    }
    if (isOpenAICompatible && providerInfo.apiType) {
      return "/providers/openai.svg";
    }
    if (isAnthropicCompatible) {
      return "/providers/anthropic-m.png";
    }
    return getProviderIconSrc(providerInfo.id);
  };

  const renderHeaderIcon = () => {
    if (headerImgError || !getHeaderIconPath()) {
      return (
        <span className="text-sm font-bold" style={{ color: providerInfo.color }}>
          {providerInfo.textIcon || providerInfo.id.slice(0, 2).toUpperCase()}
        </span>
      );
    }

    return (
      <Image
        src={getHeaderIconPath()}
        alt={providerInfo.name}
        width={56}
        height={56}
        className="max-h-14 max-w-14 rounded-xl object-contain drop-shadow-[0_1px_3px_rgba(0,0,0,0.28)]"
        sizes="56px"
        onError={() => {
          markProviderIconMissing(providerInfo.id);
          setHeaderImgError(true);
        }}
        loading="lazy"
        decoding="async"
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:gap-8 sm:px-0">
      {/* Header */}
      <div className="min-w-0">
        {!embedded && (
          <Link
            href="/dashboard/providers"
            className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
            Back to Providers
          </Link>
        )}
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          {isCompatible ? (
            <button
              type="button"
              onClick={() => setShowEditNodeIconModal(true)}
              aria-label="Edit channel icon"
              title="Edit channel icon"
              className="group relative flex size-14 shrink-0 items-center justify-center rounded-xl ring-1 ring-border-subtle outline-none transition-transform hover:scale-[1.03] hover:ring-primary/35 focus-visible:ring-2 focus-visible:ring-brand-500/70"
              style={{ backgroundColor: `${providerInfo.color}15` }}
            >
              {renderHeaderIcon()}
              <span className="material-symbols-outlined absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-[13px] text-primary shadow-sm transition-colors group-hover:border-primary/50 group-hover:bg-surface-2">
                edit
              </span>
            </button>
          ) : (
            <div
              className="flex size-14 shrink-0 items-center justify-center rounded-xl ring-1 ring-border-subtle"
              style={{ backgroundColor: `${providerInfo.color}15` }}
            >
              {renderHeaderIcon()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{providerInfo.name}</h1>
              {(providerInfo.notice?.apiKeyUrl || providerInfo.notice?.signupUrl || providerInfo.website) && (
                <a
                  href={providerInfo.notice?.apiKeyUrl || providerInfo.notice?.signupUrl || providerInfo.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">open_in_new</span>
                  {providerInfo.notice?.apiKeyUrl ? "Get API Key" : "Sign up / Learn more"}
                </a>
              )}
            </div>
            <p className="text-text-muted">
              {connections.length} 个账号 · {models.length} 个模型
            </p>
          </div>
        </div>
      </div>

      {providerInfo.deprecated && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] bg-warning/10 border border-warning/30">
          <span className="material-symbols-outlined text-[16px] text-warning mt-0.5 shrink-0">warning</span>
          <p className="text-xs text-warning leading-relaxed">{providerInfo.deprecationNotice}</p>
        </div>
      )}

      {providerInfo.notice?.text && !providerInfo.deprecated && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-info/30 bg-info/10 px-3 py-2 sm:flex-row sm:items-center">
          <span className="material-symbols-outlined text-[16px] text-info shrink-0">info</span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-info">{providerInfo.notice.text}</p>
          {providerInfo.notice.apiKeyUrl && (
            <a
              href={providerInfo.notice.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex justify-center items-center gap-1 rounded-[8px] bg-brand-500 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-brand-600 sm:py-0.5"
            >
              Get API Key
              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
            </a>
          )}
        </div>
      )}

      {/* Models */}
      <Card>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">
              {"Available Models"}
            </h2>
            {providerThinkingLevels && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="shrink-0 text-xs text-text-muted">思考</span>
                <div
                  role="radiogroup"
                  aria-label="思考等级"
                  title="复制模型名时追加 (等级) 后缀；选「自动」则不追加"
                  className="flex flex-wrap items-center gap-1"
                >
                  {providerThinkingLevels.map((opt) => {
                    const active = thinkingMode === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => handleThinkingModeChange(opt)}
                        className={`inline-flex h-7 items-center rounded-[8px] border px-2.5 text-xs transition-colors ${
                          active
                            ? "border-brand-500/45 bg-brand-500/10 font-medium text-brand-500"
                            : "border-border-subtle bg-surface-2 text-text-muted hover:border-border hover:text-text-main"
                        }`}
                      >
                        {thinkingLevelLabel(opt)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {(!isCompatible || supportsModelSync) && (() => {
            const allIds = [
              ...models,
              ...kiloFreeModels.filter((fm) => !models.some((m) => m.id === fm.id)),
            ].filter((m) => { const k = getModelKind(m); return !k || k === "llm"; }).map((m) => m.id);
            const activeIds = allIds.filter((id) => !disabledModelIds.includes(id));
            return (
              <div className="flex flex-wrap gap-2">
                {supportsModelSync && (
                  <Button
                    size="md"
                    variant="secondary"
                    icon="sync"
                    onClick={handleSyncSupportedModels}
                    disabled={syncingModels}
                    loading={syncingModels}
                  >
                    {syncingModels ? translate("Syncing models...") : translate("Sync Supported Models")}
                  </Button>
                )}
                {!isCompatible && (
                  <>
                    {disabledModelIds.length > 0 && (
                      <Button size="md" variant="secondary" icon="restart_alt" onClick={handleEnableAll}>
                        Active All
                      </Button>
                    )}
                    {activeIds.length > 0 && (
                      <Button size="md" variant="secondary" icon="block" onClick={() => handleDisableAll(activeIds)}>
                        Disable All
                      </Button>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </div>
        {!!modelsTestError && (
          <p className="text-xs text-red-500 mb-3 break-words">{modelsTestError}</p>
        )}
        {!!modelSyncStatus && (
          <p className={`mb-3 text-xs break-words ${modelSyncStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
            {modelSyncStatus.text}
          </p>
        )}
        {renderModelsSection()}
      </Card>

      {/* Modals */}
      <Modal isOpen={Boolean(taggingModel)} title={`配置模型权限 · ${taggingModel || ""}`} onClose={() => { if (!savingModelTags) setTaggingModel(null); }}>
        <div className="flex flex-col gap-5">
          <AccessTagsEditor value={modelTagDraft} onChange={setModelTagDraft} hint="模型未设置标签时所有用户都可使用；设置后，仅拥有任一相同标签的 API 密钥可调用。" />
          <div className="flex gap-2">
            <Button onClick={saveModelTags} loading={savingModelTags} fullWidth>保存标签</Button>
            <Button variant="ghost" onClick={() => setTaggingModel(null)} disabled={savingModelTags} fullWidth>取消</Button>
          </div>
        </div>
      </Modal>

      {isCompatible && (
        <EditCompatibleNodeIconModal
          isOpen={showEditNodeIconModal}
          node={providerNode}
          onSave={handleUpdateNodeIcon}
          onClose={() => setShowEditNodeIconModal(false)}
        />
      )}
      {!isCompatible && (
        <AddCustomModelModal
          key={showAddCustomModel ? "open" : "closed"}
          isOpen={showAddCustomModel}
          providerAlias={providerStorageAlias}
          providerDisplayAlias={providerDisplayAlias}
          onSave={async (modelId) => {
            const saved = await handleAddCustomModel(modelId, "llm", providerStorageAlias);
            if (saved) setShowAddCustomModel(false);
            return saved;
          }}
          onClose={() => setShowAddCustomModel(false)}
        />
      )}

      {/* Mounted per model so the draft state seeds exactly once (see the modal). */}
      {capabilitiesModel && (
        <ModelCapabilitiesModal
          key={capabilitiesModel.key}
          isOpen
          modelId={capabilitiesModel.id}
          fullModel={capabilitiesModel.fullModel}
          caps={capabilitiesModel.caps}
          saving={savingCapabilities}
          onSave={handleSaveModelCapabilities}
          onClose={() => { if (!savingCapabilities) setCapabilitiesModel(null); }}
        />
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
