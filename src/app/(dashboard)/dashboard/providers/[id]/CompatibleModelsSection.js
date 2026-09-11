"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Toggle } from "@/shared/components";
import { CAPACITY_META } from "@/shared/constants/models";
import { cn } from "@/shared/utils/cn";
import { describeModelSource, getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";

const CAPABILITY_KEYS = Object.keys(CAPACITY_META);

function getModelRole(modelId) {
  const id = modelId.toLowerCase();
  if (/(embedding|embed)/.test(id)) return { icon: "data_object", label: "Embedding" };
  if (/(rerank|ranker)/.test(id)) return { icon: "sort", label: "Rerank" };
  if (/(image|vision)/.test(id)) return { icon: "image", label: "Image" };
  return { icon: "smart_toy", label: "LLM" };
}

function CompatibleModelCard({ modelId, fullModel, caps, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting, isEnabled, onToggleEnabled, menuOpen, onToggleMenu, onCloseMenu, accessTags = [], onEditAccessTags, onEditCapabilities, onToggleCapability, busyCapabilityKey, sourceLabel }) {
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border-subtle";
  const role = getModelRole(modelId);
  const statusIcon = testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : role.icon;
  const statusColor = testStatus === "ok" ? "text-green-500" : testStatus === "error" ? "text-red-500" : "text-text-muted";
  const canToggleCaps = typeof onToggleCapability === "function";

  return (
    <article className={`group relative min-w-0 rounded-xl border ${borderColor} bg-bg/30 transition-colors hover:border-primary/35 hover:bg-sidebar/45 ${!isEnabled ? "opacity-60" : ""}`}>
      <header className="flex min-h-[52px] min-w-0 items-start gap-2 border-b border-border-subtle px-3 py-2.5">
        <span className={`material-symbols-outlined mt-0.5 shrink-0 text-[18px] ${statusColor}`} title={testStatus === "ok" ? "测试通过" : testStatus === "error" ? "测试失败" : role.label}>
          {statusIcon}
        </span>
        <p className="min-w-0 flex-1 break-words text-sm font-semibold leading-5 text-text-main line-clamp-2" title={modelId}>{modelId}</p>
        <div className="flex shrink-0 items-center gap-0.5">
          {onEditCapabilities && (
            <button
              type="button"
              onClick={onEditCapabilities}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-sidebar hover:text-text-main"
              title="上下文长度与最大输出"
              aria-label={`${modelId} 上下文长度与最大输出`}
            >
              <span className="material-symbols-outlined text-[18px]">tune</span>
            </button>
          )}
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
        </div>
      </header>

      <div className="min-w-0 px-3 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate rounded bg-sidebar px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{sourceLabel || role.label}</span>
          <span className="shrink-0" title={isEnabled ? "停用模型" : "启用模型"}>
            <Toggle
              size="sm"
              checked={isEnabled}
              onChange={onToggleEnabled}
              ariaLabel={`${modelId}${isEnabled ? "：已启用，点击停用" : "：已停用，点击启用"}`}
            />
          </span>
        </div>
        <code className="mt-2 block truncate rounded-md bg-sidebar px-2 py-1.5 font-mono text-[10px] text-text-muted" title={fullModel}>{fullModel}</code>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {CAPABILITY_KEYS.map((key) => {
            const meta = CAPACITY_META[key];
            const active = Boolean(caps?.[key]);
            const busy = busyCapabilityKey === key;
            return (
              <button
                key={key}
                type="button"
                disabled={!canToggleCaps || busy}
                aria-pressed={active}
                onClick={() => onToggleCapability?.(key, !active)}
                title={`${meta.label} · ${meta.desc}（点击${active ? "关闭" : "开启"}）`}
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-[6px] border transition-colors",
                  active
                    ? "border-border-subtle bg-surface-2 hover:border-primary/45"
                    : "border-border-subtle/60 bg-surface-2/25 hover:border-border-subtle hover:bg-surface-2/60",
                  !canToggleCaps && "cursor-default",
                  busy && "opacity-40",
                )}
              >
                <span className={cn("material-symbols-outlined", active ? meta.color : "text-text-muted/35")} style={{ fontSize: "14px" }}>
                  {meta.icon}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {menuOpen && (
        <div role="menu" className="absolute right-2 top-10 z-20 min-w-36 rounded-lg border border-border-subtle bg-surface p-1 shadow-[var(--shadow-elev)]">
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
            onClick={() => { onCloseMenu(); onEditAccessTags(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-main transition-colors hover:bg-sidebar"
          >
            <span className={`material-symbols-outlined text-[16px] ${accessTags.length > 0 ? "text-violet-300" : "text-text-muted"}`}>sell</span>
            权限标签{accessTags.length > 0 ? ` (${accessTags.length})` : ""}
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

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, onDisableModel, onEnableModel, disabledModelIds, connections, getCaps, isAnthropic, modelAccessTags, onEditAccessTags, onEditCapabilities, onToggleCapability, capabilityOverrides = {}, togglingCapability = null }) {
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
      const saved = await onAddCustomModel(modelId);
      if (saved !== false) setNewModel("");
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
        const saved = await onAddCustomModel(modelId);
        if (saved !== false) importedCount += 1;
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
        手动添加 {isAnthropic ? "Anthropic" : "OpenAI"} 兼容模型，或从上游 /models 接口批量导入。
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <Input
          className="min-w-[240px] flex-1"
          label="Model ID"
          value={newModel}
          onChange={(e) => setNewModel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
          inputClassName="font-mono text-xs"
        />
        <Button size="md" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="md" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing} loading={importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          先添加一个可用连接，才能从上游导入模型。
        </p>
      )}

      {allModels.length > 0 && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {allModels.map(({ id, alias, source, modelSource, providerId, capabilities }) => {
            const capsKey = `${providerStorageAlias}/${id}`;
            // Locally stored capabilities win; the shared resolver fills the rest
            // so a partially-known model still shows every applicable badge.
            const caps = { ...(getCaps(capsKey) || {}), ...(capabilities || {}) };
            const sourceLabel = describeModelSource(modelSource);
            return (
              <CompatibleModelCard
                key={`${source}-${providerStorageAlias}/${id}`}
                modelId={id}
                fullModel={`${providerDisplayAlias}/${id}`}
                caps={caps}
                sourceLabel={sourceLabel}
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
                accessTags={modelAccessTags[`${providerStorageAlias}/${id}`] || []}
                onEditAccessTags={() => onEditAccessTags(`${providerStorageAlias}/${id}`)}
                onEditCapabilities={() => onEditCapabilities?.({
                  id,
                  providerAlias: providerStorageAlias,
                  providerId: providerId || providerStorageAlias,
                  fullModel: `${providerDisplayAlias}/${id}`,
                  caps,
                })}
                onToggleCapability={(key, value) => onToggleCapability?.({
                  providerAlias: providerStorageAlias,
                  providerId: providerId || providerStorageAlias,
                  id,
                  overrideCaps,
                  key,
                  value,
                })}
                busyCapabilityKey={busyCapabilityKey}
              />
            );
          })}
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
  modelAccessTags: PropTypes.object.isRequired,
  onEditAccessTags: PropTypes.func.isRequired,
  onEditCapabilities: PropTypes.func,
  onToggleCapability: PropTypes.func,
  capabilityOverrides: PropTypes.object,
  togglingCapability: PropTypes.string,
};

CompatibleModelCard.propTypes = {
  sourceLabel: PropTypes.string,
  onEditCapabilities: PropTypes.func,
  onToggleCapability: PropTypes.func,
  busyCapabilityKey: PropTypes.string,
};
