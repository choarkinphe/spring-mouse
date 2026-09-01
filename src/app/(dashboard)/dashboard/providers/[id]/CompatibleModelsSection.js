"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Toggle } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
const CAPABILITY_ICONS = [
  { key: "vision", icon: "visibility", label: "视觉输入" },
  { key: "reasoning", icon: "neurology", label: "思考" },
  { key: "pdf", icon: "picture_as_pdf", label: "PDF 输入" },
  { key: "audioInput", icon: "mic", label: "音频输入" },
  { key: "videoInput", icon: "videocam", label: "视频输入" },
  { key: "imageOutput", icon: "image", label: "图像生成" },
  { key: "audioOutput", icon: "volume_up", label: "音频生成" },
  { key: "search", icon: "travel_explore", label: "联网搜索" },
];

function getModelRole(modelId) {
  const id = modelId.toLowerCase();
  if (/(embedding|embed)/.test(id)) return { icon: "data_object", label: "Embedding" };
  if (/(rerank|ranker)/.test(id)) return { icon: "sort", label: "Rerank" };
  if (/(image|vision)/.test(id)) return { icon: "image", label: "Image" };
  return { icon: "smart_toy", label: "LLM" };
}

function ModelCapabilityIcons({ caps }) {
  const active = CAPABILITY_ICONS.filter(({ key }) => caps?.[key]);

  return (
    <span className="flex items-center gap-1 text-text-muted" aria-label={active.map(({ label }) => label).join("、") || "文本"}>
      {active.length > 0 ? active.map(({ key, icon, label }) => (
        <span key={key} className="material-symbols-outlined text-[15px]" title={label}>{icon}</span>
      )) : <span className="material-symbols-outlined text-[15px]" title="文本">text_fields</span>}
    </span>
  );
}

function CompatibleModelCard({ modelId, fullModel, caps, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting, isEnabled, onToggleEnabled, menuOpen, onToggleMenu, onCloseMenu }) {
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border-subtle";
  const role = getModelRole(modelId);
  const statusIcon = testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : role.icon;
  const statusColor = testStatus === "ok" ? "text-green-500" : testStatus === "error" ? "text-red-500" : "text-text-muted";

  return (
    <article className={`group relative min-w-0 rounded-xl border ${borderColor} bg-bg/30 transition-colors hover:border-primary/35 hover:bg-sidebar/45 ${!isEnabled ? "opacity-60" : ""}`}>
      <header className="flex min-h-[52px] min-w-0 items-start gap-2 border-b border-border-subtle px-3 py-2.5">
        <span className={`material-symbols-outlined mt-0.5 shrink-0 text-[18px] ${statusColor}`} title={testStatus === "ok" ? "测试通过" : testStatus === "error" ? "测试失败" : role.label}>
          {statusIcon}
        </span>
        <p className="min-w-0 flex-1 break-words text-sm font-semibold leading-5 text-text-main line-clamp-2" title={modelId}>{modelId}</p>
        <button
          type="button"
          onClick={onToggleMenu}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-sidebar hover:text-text-main"
          title="更多操作"
          aria-label={`${modelId} 更多操作`}
          aria-expanded={menuOpen}
        >
          <span className="material-symbols-outlined text-[18px]">more_horiz</span>
        </button>
      </header>

      <div className="min-w-0 px-3 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-sidebar px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{role.label}</span>
            <ModelCapabilityIcons caps={caps} />
          </div>
          <span title={isEnabled ? "停用模型" : "启用模型"}>
            <Toggle
              size="sm"
              checked={isEnabled}
              onChange={onToggleEnabled}
              ariaLabel={`${modelId}${isEnabled ? "：已启用，点击停用" : "：已停用，点击启用"}`}
            />
          </span>
        </div>
        <code className="mt-2 block truncate rounded-md bg-sidebar px-2 py-1.5 font-mono text-[10px] text-text-muted" title={fullModel}>{fullModel}</code>
      </div>

      {menuOpen && (
        <div role="menu" className="absolute right-2 top-10 z-10 min-w-32 rounded-lg border border-border-subtle bg-surface p-1 shadow-[var(--shadow-elev)]">
          {onTest && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onCloseMenu(); onTest(); }}
              disabled={isTesting}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-main transition-colors hover:bg-sidebar disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[16px]" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>{isTesting ? "progress_activity" : "science"}</span>
              {isTesting ? "测试中..." : "测试模型"}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => { onCopy(fullModel, `model-${modelId}`); onCloseMenu(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-main transition-colors hover:bg-sidebar"
          >
            <span className="material-symbols-outlined text-[16px]">{copied === `model-${modelId}` ? "check" : "content_copy"}</span>
            {copied === `model-${modelId}` ? "已复制" : "复制模型 ID"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { onCloseMenu(); onDeleteAlias(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
            删除模型
          </button>
        </div>
      )}
    </article>
  );
}

ModelCapabilityIcons.propTypes = {
  caps: PropTypes.object,
};


export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, onDisableModel, onEnableModel, disabledModelIds, connections, getCaps, isAnthropic }) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testingModelId, setTestingModelId] = useState(null);
  const [modelTestResults, setModelTestResults] = useState({});
  const [openModelMenuId, setOpenModelMenuId] = useState(null);

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      setTestingModelId(null);
    }
  };

  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to import models");
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert("No models returned from /models.");
        return;
      }
      let importedCount = 0;
      for (const model of models) {
        const modelId = model.id || model.name || model.model;
        if (!modelId) continue;
        if (allModels.some((entry) => entry.id === modelId)) continue;
        await onAddCustomModel(modelId);
        importedCount += 1;
      }
      if (importedCount === 0) {
        alert("No new models were added.");
      }
    } catch (error) {
      console.log("Error importing models:", error);
    } finally {
      setImporting(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {allModels.length > 0 && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {allModels.map(({ id, alias, source, capabilities }) => (
            <CompatibleModelCard
              key={`${source}-${providerStorageAlias}/${id}`}
              modelId={id}
              fullModel={`${providerDisplayAlias}/${id}`}
              caps={capabilities || getCaps(`${providerStorageAlias}/${id}`)}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id) : onDeleteAlias(alias)}
              onTest={connections.length > 0 ? () => handleTestModel(id) : undefined}
              testStatus={modelTestResults[id]}
              isTesting={testingModelId === id}
              isEnabled={!disabledModelIds.includes(id)}
              onToggleEnabled={(enabled) => enabled ? onEnableModel(id) : onDisableModel(id)}
              menuOpen={openModelMenuId === `${source}-${id}`}
              onToggleMenu={() => setOpenModelMenuId((current) => current === `${source}-${id}` ? null : `${source}-${id}`)}
              onCloseMenu={() => setOpenModelMenuId(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  onDisableModel: PropTypes.func.isRequired,
  onEnableModel: PropTypes.func.isRequired,
  disabledModelIds: PropTypes.arrayOf(PropTypes.string).isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  getCaps: PropTypes.func.isRequired,
  isAnthropic: PropTypes.bool,
};
