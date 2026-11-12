"use client";

import { useState, useCallback, useEffect } from "react";
import PropTypes from "prop-types";
import { Card, Button, Drawer } from "@/shared/components";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getProviderAlias, isNonChatServiceProvider, supportsLiveModelSync } from "@/shared/constants/providers";
import { shouldUseStaticModelCatalog, isVisibleModelCatalogRow } from "@/shared/utils/providerCustomModels";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { getCodexImageCandidates } from "@/shared/utils/codexImageModels";
import { CODEX_NATIVE_IMAGE_MODEL } from "open-sse/config/codexImage.js";

// ── ModelRow ───────────────────────────────────────────────────
export function ModelRow({ model, fullModel, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting }) {
  const borderColor = testStatus === "ok" ? "border-green-500/40" : testStatus === "error" ? "border-red-500/40" : "border-border";
  const iconColor = testStatus === "ok" ? "#22c55e" : testStatus === "error" ? "#ef4444" : undefined;

  return (
    <div className={`group px-3 py-2 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-base" style={iconColor ? { color: iconColor } : undefined}>
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
        </span>
        <div className="flex flex-col gap-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          {model.name && <span className="text-[9px] text-text-muted/70 italic pl-1">{model.name}</span>}
          {model.verified === false && <span className="text-[9px] text-amber-600 pl-1">内置·未验证</span>}
          {model.verified === true && <span className="text-[9px] text-emerald-600 pl-1">官方目录</span>}
          {model.warning && <span className="text-[10px] text-amber-600 pl-1">{model.warning}</span>}
        </div>
        {onTest && (
          <div className="relative group/btn">
            <button aria-label={`测试 ${fullModel}`} title="测试模型（实际请求上游）" onClick={onTest} disabled={isTesting} className={`p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-opacity ${isTesting ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
              <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {isTesting ? "Testing..." : "Test"}
            </span>
          </div>
        )}
        <div className="relative group/btn">
          <button onClick={() => onCopy(fullModel, `model-${model.id}`)} className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary">
            <span className="material-symbols-outlined text-sm">{copied === `model-${model.id}` ? "check" : "content_copy"}</span>
          </button>
          <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
            {copied === `model-${model.id}` ? "Copied!" : "Copy"}
          </span>
        </div>
        {isFree && <span className="text-[10px] font-bold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">FREE</span>}
        {isCustom && (
          <button onClick={onDeleteAlias} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity ml-auto" title="Remove custom model">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        )}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({ id: PropTypes.string.isRequired }).isRequired,
  fullModel: PropTypes.string.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
};

// ── AddCustomModelModal ────────────────────────────────────────
function AddCustomModelModal({ isOpen, onSave, onClose }) {
  const [modelId, setModelId] = useState("");

  const handleSave = () => {
    if (!modelId.trim()) return;
    onSave(modelId.trim());
    setModelId("");
  };

  return (
    <Drawer isOpen={isOpen} title="Add Custom Model" onClose={onClose} width="md">
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="e.g. tts-1-hd"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={!modelId.trim()}>Add</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Drawer>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ModelsCard ─────────────────────────────────────────────────
// Self-contained card: shows models for a provider, filtered by optional `kindFilter`.
// kindFilter: if provided, only shows models with matching type/kinds field.
export default function ModelsCard({ providerId, kindFilter, providerAliasOverride }) {
  const { copied, copy } = useCopyToClipboard();
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [snapshots, setSnapshots] = useState({});
  const [modelTestResults, setModelTestResults] = useState({});
  const [testingModelId, setTestingModelId] = useState(null);
  const [testError, setTestError] = useState("");
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const codexImage = providerId === "codex" && kindFilter === "image";
  const [connections, setConnections] = useState([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedImageModel, setSelectedImageModel] = useState("");
  const [addingModel, setAddingModel] = useState(false);

  const providerAlias = providerAliasOverride || getProviderAlias(providerId);
  const effectiveType = kindFilter || "llm";
  // Native (non-chat) providers: their models can't be pinged through the chat
  // endpoint, and their live list is synced (not just the static seed).
  const nonChat = isNonChatServiceProvider(providerId);
  const canSync = supportsLiveModelSync(providerId);
  const [syncingModels, setSyncingModels] = useState(false);
  const [modelSyncStatus, setModelSyncStatus] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [aliasRes, customRes] = await Promise.all([
        fetch("/api/models/alias"),
        fetch("/api/models/custom", { cache: "no-store" }),
      ]);
      const aliasData = await aliasRes.json();
      const customData = await customRes.json();
      if (aliasRes.ok) setModelAliases(aliasData.aliases || {});
      if (customRes.ok) { setCustomModels(customData.models || []); setSnapshots(customData.snapshots || {}); }
    } catch (e) { console.log("ModelsCard fetch error:", e); }
  }, []);

  useEffect(() => { Promise.resolve().then(fetchData); }, [fetchData]);

  useEffect(() => {
    if (!canSync && !codexImage) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/providers", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "读取连接失败");
        if (cancelled) return;
        const active = (data.connections || []).filter((c) => c.provider === providerId && c.isActive !== false);
        setConnections(active);
        setSelectedConnectionId((previous) => active.some((c) => c.id === previous) ? previous : active.length === 1 ? active[0].id : "");
      } catch (error) {
        if (!cancelled) setModelSyncStatus({ type: "error", text: error.message });
      }
    };
    load();
    window.addEventListener("providersChanged", load);
    return () => { cancelled = true; window.removeEventListener("providersChanged", load); };
  }, [canSync, codexImage, providerId]);

  const hasSelectedAccount = connections.some((connection) => connection.id === selectedConnectionId && connection.provider === providerId && connection.isActive !== false);
  const imageCandidates = codexImage ? getCodexImageCandidates(null, hasSelectedAccount ? selectedConnectionId : "") : [];
  const selectedCandidate = imageCandidates.find((candidate) => candidate.id === selectedImageModel) || imageCandidates[0];

  const handleSetAlias = async (modelId, alias) => {
    const fullModel = `${providerAlias}/${modelId}`;
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: fullModel, alias }),
      });
      if (res.ok) await fetchData();
    } catch (e) { console.log("set alias error:", e); }
  };

  const handleDeleteAlias = async (alias) => {
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, { method: "DELETE" });
      if (res.ok) await fetchData();
    } catch (e) { console.log("delete alias error:", e); }
  };

  const handleAddCustomModel = async (modelId) => {
    setAddingModel(true);
    try {
      const res = await fetch("/api/models/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias, id: modelId, type: effectiveType, ...(codexImage ? { connectionId: selectedConnectionId } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "添加模型失败");
      await fetchData();
      window.dispatchEvent(new CustomEvent("customModelChanged"));
      setShowAddCustomModel(false);
      setTestError("");
    } catch (error) { setTestError(error.message); }
    finally { setAddingModel(false); }
  };

  const handleDeleteCustomModel = async (modelId, storedProviderAlias = providerAlias) => {
    try {
      const params = new URLSearchParams({ providerAlias: storedProviderAlias, id: modelId, type: effectiveType });
      const res = await fetch(`/api/models/custom?${params}`, { method: "DELETE" });
      if (res.ok) {
        await fetchData();
        window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (e) { console.log("delete custom model error:", e); }
  };

  // Pull this provider's live model list into the local catalog. Mirrors the
  // chat-side sync flow: fetch the connection's /models, then POST to model-sync.
  const handleSyncModels = async () => {
    if (syncingModels) return;
    setSyncingModels(true);
    setModelSyncStatus(null);
    try {
      const connRes = await fetch("/api/providers", { cache: "no-store" });
      const connData = await connRes.json().catch(() => ({}));
      if (!connRes.ok) throw new Error(connData.error || "读取连接失败");
      const activeConnections = (connData.connections || []).filter((connection) => connection.provider === providerId && connection.isActive !== false);
      setConnections(activeConnections);
      const activeConnection = activeConnections.find((connection) => connection.id === selectedConnectionId)
        || (activeConnections.length === 1 ? activeConnections[0] : null);
      if (!activeConnection) {
        setModelSyncStatus({ type: "error", text: activeConnections.length ? "请选择用于同步的账号" : "请先添加并启用一个连接" });
        return;
      }
      setSelectedConnectionId(activeConnection.id);

      const res = await fetch("/api/providers/model-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, connectionId: activeConnection.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setModelSyncStatus({ type: "error", text: data.error || "同步模型失败" });
        return;
      }
      await fetchData();
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      setModelTestResults({});
      setTestError("");
      setModelSyncStatus({ type: "success", text: `已同步 ${data.total} 个模型` });
    } catch (error) {
      setModelSyncStatus({ type: "error", text: `同步模型失败: ${error.message}` });
    } finally {
      setSyncingModels(false);
    }
  };

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    if (codexImage && !hasSelectedAccount) {
      setTestError("请先选择用于出图测试的账号");
      return;
    }
    if (codexImage && !imageCandidates.some((candidate) => candidate.id === modelId)) {
      setTestError("旧版聊天模型图像别名不再用于测试，请选择原生图像模型 gpt-image-2");
      return;
    }
    setTestingModelId(modelId);
    setTestError("");
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${modelId}`, kind: kindFilter, ...(codexImage ? { connectionId: selectedConnectionId } : {}) }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
      setTestError(data.ok ? "" : (data.error || "Model not reachable"));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      setTestError("Network error");
    } finally { setTestingModelId(null); }
  };

  // Built-in models — filter by kindFilter if provided
  const allBuiltIn = !codexImage && shouldUseStaticModelCatalog(providerId, snapshots) ? getModelsByProviderId(providerId) : [];
  const builtInModels = kindFilter
    ? allBuiltIn.filter((m) => {
        if (m.kinds) return m.kinds.includes(kindFilter);
        return getModelKind(m, "llm") === kindFilter;
      })
    : allBuiltIn;

  // Custom models for this provider + kind, dedupe vs built-in
  const myCustomModels = customModels.filter(
    (m) => (codexImage ? m.id && m.origin !== "capability-override" : isVisibleModelCatalogRow(m, snapshots))
      && (m.providerAlias === providerAlias || (codexImage && ["cx", "codex"].includes(m.providerAlias)))
      && getModelKind(m, "llm") === effectiveType
      && !builtInModels.some((b) => b.id === m.id)
  );

  const displayModels = builtInModels;

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{nonChat || codexImage ? "模型" : "Models"}{kindFilter ? ` — ${kindFilter.toUpperCase()}` : ""}</h2>
          {canSync && !codexImage && (
            <Button
              size="sm"
              variant="secondary"
              icon="sync"
              aria-label="同步官方模型目录"
              disabled={syncingModels || Boolean(testingModelId) || addingModel}
              onClick={handleSyncModels}
            >
              {syncingModels ? "同步中…" : "同步模型"}
            </Button>
          )}
        </div>
        {(canSync || codexImage) && (
          <div className="mb-4 flex flex-col gap-2">
            <label className="text-xs text-text-muted" htmlFor={`sync-account-${providerId}`}>{codexImage ? "出图测试账号" : "同步账号"}</label>
            <select
              id={`sync-account-${providerId}`}
              aria-label={codexImage ? "出图测试账号" : "模型同步账号"}
              value={selectedConnectionId}
              disabled={syncingModels || Boolean(testingModelId) || addingModel}
              onChange={(event) => {
                setSelectedConnectionId(event.target.value);
                setSelectedImageModel("");
                setModelTestResults({});
                setModelSyncStatus(null);
                setTestError("");
              }}
              className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">选择账号</option>
              {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name || connection.email || connection.id}</option>)}
            </select>
          </div>
        )}
        {codexImage && (
          <div className="mb-4 space-y-3 rounded-lg border border-border p-3">
            <p className="text-xs leading-5 text-text-muted">使用 Codex 原生图像模型 gpt-image-2，无需同步聊天模型目录，也不通过聊天模型调用图像工具。出图权限取决于所选账号，需实际测试确认。测试会生成图片并消耗额度，仅使用所选账号。</p>
            <label className="block text-xs text-text-muted" htmlFor="codex-image-base-model">原生图像模型</label>
            <select id="codex-image-base-model" aria-label="原生图像模型" value={selectedCandidate?.id || ""} disabled={!hasSelectedAccount || addingModel || Boolean(testingModelId)} onChange={(event) => setSelectedImageModel(event.target.value)} className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm">
              {!imageCandidates.length && <option value="">请先选择启用的 Codex 账号</option>}
              {imageCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
            </select>
            {selectedCandidate && <p className="break-all text-xs text-text-muted">图像模型：{providerAlias}/{selectedCandidate.id}（所选账号出图权限需实测）</p>}
            <Button aria-label="添加 Codex 图像路由" size="sm" icon="add" disabled={!selectedCandidate || addingModel || Boolean(testingModelId)} onClick={() => handleAddCustomModel(selectedCandidate.id)}>{addingModel ? "添加中…" : "添加图像路由"}</Button>
          </div>
        )}
        {modelSyncStatus && (
          <p className={`text-xs mb-3 break-words ${modelSyncStatus.type === "error" ? "text-red-500" : "text-green-600"}`}>
            {modelSyncStatus.text}
          </p>
        )}
        {testError && <p className="text-xs text-red-500 mb-3 break-words">{testError}</p>}

        <div className="flex flex-wrap gap-3">
          {displayModels.map((model) => {
            const fullModel = `${providerAlias}/${model.id}`;
            const existingAlias = Object.entries(modelAliases).find(([, m]) => m === fullModel)?.[0];
            return (
              <ModelRow
                key={model.id}
                model={{ ...model, verified: snapshots[providerId]?.status === "success" ? (snapshots[providerId].modelIds || []).some((entry) => (typeof entry === "string" ? entry : entry?.id) === model.id) : false }}
                fullModel={`${providerAlias}/${model.id}`}
                alias={existingAlias}
                copied={copied}
                onCopy={copy}
                onSetAlias={(alias) => handleSetAlias(model.id, alias)}
                onDeleteAlias={() => handleDeleteAlias(existingAlias)}
                testStatus={modelTestResults[model.id]}
                onTest={nonChat && !codexImage ? undefined : () => handleTestModel(model.id)}
                isTesting={testingModelId === model.id}
                isFree={model.isFree}
              />
            );
          })}

          {myCustomModels.map((model) => (
            <ModelRow
              key={`${model.providerAlias}-${model.id}-${model.type}`}
              model={{ id: model.id, name: codexImage ? (model.id === CODEX_NATIVE_IMAGE_MODEL ? `原生图像模型 · ${modelTestResults[model.id] === "ok" ? "所选账号出图测试通过" : "出图权限需实测"}` : model.name) : model.name, ...(codexImage && model.id !== CODEX_NATIVE_IMAGE_MODEL ? { warning: "旧版聊天模型图像别名，未验证且不再用于测试；可手动移除并改用 gpt-image-2" } : {}), ...(!codexImage && model.source === "official" ? { verified: true } : {}) }}
              fullModel={`${model.providerAlias}/${model.id}`}
              copied={copied}
              onCopy={copy}
              onSetAlias={() => {}}
              onDeleteAlias={() => handleDeleteCustomModel(model.id, model.providerAlias)}
              testStatus={modelTestResults[model.id]}
              onTest={(nonChat && !codexImage) || (codexImage && model.id !== CODEX_NATIVE_IMAGE_MODEL) ? undefined : () => handleTestModel(model.id)}
              isTesting={testingModelId === model.id}
              isCustom
            />
          ))}

          {!codexImage && <button
            onClick={() => setShowAddCustomModel(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-black/15 dark:border-white/15 text-xs text-text-muted hover:text-primary hover:border-primary/40 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            {nonChat ? "添加模型" : "Add Model"}
          </button>}
        </div>
      </Card>

      <AddCustomModelModal
        isOpen={showAddCustomModel}
        onSave={handleAddCustomModel}
        onClose={() => setShowAddCustomModel(false)}
      />
    </>
  );
}

ModelsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  kindFilter: PropTypes.string, // e.g. "tts", "embedding" — filters models shown
  providerAliasOverride: PropTypes.string, // override alias (e.g. for custom-embedding nodes using prefix)
};
