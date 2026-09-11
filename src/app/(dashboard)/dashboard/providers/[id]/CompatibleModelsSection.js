"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { SelectionCheckbox, Toggle } from "@/shared/components";
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

function CompatibleModelCard({ modelId, fullModel, caps, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting, isEnabled, onToggleEnabled, menuOpen, onToggleMenu, onCloseMenu, accessTags = [], onEditAccessTags, onEditCapabilities, onToggleCapability, busyCapabilityKey, sourceLabel, selectable = false, selected = false, onToggleSelect }) {
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
    <article className={`group relative min-w-0 rounded-xl border ${borderColor} bg-bg/30 transition-colors hover:border-primary/35 hover:bg-sidebar/45 ${!isEnabled ? "opacity-60" : ""} ${selected ? "border-primary/60!" : ""}`}>
      <header className="flex min-h-[52px] min-w-0 items-start gap-2 border-b border-border-subtle px-3 py-2.5">
        {selectable && (
          <SelectionCheckbox checked={selected} onChange={onToggleSelect} label={`选择模型 ${modelId}`} />
        )}
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

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onDeleteCustomModel, onDisableModel, onEnableModel, disabledModelIds, connections, getCaps, modelAccessTags, onEditAccessTags, onEditCapabilities, onToggleCapability, onOpenAddModel, capabilityOverrides = {}, togglingCapability = null, modelTestResults = {}, testingModelIds, onTestModel, selectable = false, selectedModelIds, onToggleSelect }) {
  const [openModelMenuId, setOpenModelMenuId] = useState(null);

  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });

  const hasActiveConnection = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      {!hasActiveConnection && (
        <p className="text-xs text-text-muted">
          先添加一个可用账号，才能测试模型或同步上游列表。
        </p>
      )}

        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <button
            type="button"
            onClick={onOpenAddModel}
            className="flex min-h-[116px] w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-2/40 px-4 py-3 text-sm font-semibold text-text-muted transition-colors hover:border-primary/50 hover:bg-primary/[0.05] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            添加模型
          </button>
          {allModels.map(({ id, alias, source, modelSource, providerId, capabilities }) => {
            const capsKey = `${providerStorageAlias}/${id}`;
            // Mirror ProviderDetailClient: the parent tracks the in-flight toggle as
            // "<alias>|<modelId>|<capabilityKey>"; the card only needs the suffix.
            const busyPrefix = `${providerStorageAlias}|${id}|`;
            const busyCapabilityKey = togglingCapability?.startsWith(busyPrefix)
              ? togglingCapability.slice(busyPrefix.length)
              : null;
            // Locally stored capabilities win; the shared resolver fills the rest
            // so a partially-known model still shows every applicable badge.
            const caps = { ...(getCaps(capsKey) || {}), ...(capabilities || {}) };
            const sourceLabel = describeModelSource(modelSource);
            const overrideCaps = capabilities || capabilityOverrides[`${providerStorageAlias}|${id}|llm`] || {};
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
                onTest={connections.length > 0 && onTestModel ? () => onTestModel(id) : undefined}
                testStatus={modelTestResults[id]}
                isTesting={Boolean(testingModelIds?.has(id))}
                selectable={selectable}
                selected={Boolean(selectedModelIds?.has(id))}
                onToggleSelect={() => onToggleSelect?.(id)}
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
  onOpenAddModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  onDisableModel: PropTypes.func.isRequired,
  onEnableModel: PropTypes.func.isRequired,
  disabledModelIds: PropTypes.arrayOf(PropTypes.string).isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  getCaps: PropTypes.func.isRequired,
  modelAccessTags: PropTypes.object.isRequired,
  onEditAccessTags: PropTypes.func.isRequired,
  onEditCapabilities: PropTypes.func,
  onToggleCapability: PropTypes.func,
  capabilityOverrides: PropTypes.object,
  togglingCapability: PropTypes.string,
  modelTestResults: PropTypes.object,
  testingModelIds: PropTypes.object,
  onTestModel: PropTypes.func,
  selectable: PropTypes.bool,
  selectedModelIds: PropTypes.object,
  onToggleSelect: PropTypes.func,
};

CompatibleModelCard.propTypes = {
  sourceLabel: PropTypes.string,
  onEditCapabilities: PropTypes.func,
  onToggleCapability: PropTypes.func,
  busyCapabilityKey: PropTypes.string,
  selectable: PropTypes.bool,
  selected: PropTypes.bool,
  onToggleSelect: PropTypes.func,
};
