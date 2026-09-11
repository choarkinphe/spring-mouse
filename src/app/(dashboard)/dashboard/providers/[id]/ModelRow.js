"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { CAPACITY_META } from "@/shared/constants/models";
import { cn } from "@/shared/utils/cn";
import { SelectionCheckbox } from "@/shared/components";

const CAPABILITY_KEYS = Object.keys(CAPACITY_META);

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, caps, thinkingSuffix, accessTags = [], onEditAccessTags, onEditCapabilities, onToggleCapability, busyCapabilityKey, sourceLabel, selectable = false, selected = false, onToggleSelect }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border-subtle";
  const statusIcon = testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy";
  const statusColor = testStatus === "ok" ? "text-green-500" : testStatus === "error" ? "text-red-500" : "text-text-muted";
  const modelType = isCustom ? (sourceLabel || "Custom") : isFree ? "Free" : "LLM";
  const canToggleCaps = typeof onToggleCapability === "function";

  const runMenuAction = (action) => {
    setMenuOpen(false);
    action?.();
  };

  return (
    <article className={`group relative min-w-0 rounded-xl border ${borderColor} bg-bg/30 transition-colors hover:border-primary/35 hover:bg-sidebar/45 ${selected ? "border-primary/60! bg-primary/[0.04]" : ""}`}>
      <header className="flex min-h-[52px] min-w-0 items-start gap-2 border-b border-border-subtle px-3 py-2.5">
        {selectable && (
          <SelectionCheckbox checked={selected} onChange={onToggleSelect} label={`选择模型 ${model.id}`} />
        )}
        <span className={`material-symbols-outlined mt-0.5 shrink-0 text-[18px] ${statusColor}`}>
          {statusIcon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-sm font-semibold leading-5 text-text-main" title={model.id}>{model.id}</p>
          {alias && <p className="mt-0.5 truncate font-mono text-[10px] text-primary/75" title={alias}>Alias: {alias}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {onEditCapabilities && (
            <button
              type="button"
              onClick={onEditCapabilities}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-sidebar hover:text-text-main"
              title="上下文长度与最大输出"
              aria-label={`${model.id} 上下文长度与最大输出`}
            >
              <span className="material-symbols-outlined text-[18px]">tune</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((current) => !current)}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-sidebar hover:text-text-main"
            title="更多操作"
            aria-label={`${model.id} 更多操作`}
            aria-expanded={menuOpen}
          >
            <span className="material-symbols-outlined text-[18px]">more_horiz</span>
          </button>
        </div>
      </header>

      <div className="min-w-0 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-sidebar px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{modelType}</span>
          {model.name && model.name !== model.id && (
            <span className="min-w-0 flex-1 truncate text-[10px] italic text-text-muted/70" title={model.name}>{model.name}</span>
          )}
        </div>
        <code className="mt-2 block truncate rounded-md bg-sidebar px-2 py-1.5 font-mono text-[10px] text-text-muted" title={displayModel}>{displayModel}</code>
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
              onClick={() => runMenuAction(onTest)}
              disabled={isTesting}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-main transition-colors hover:bg-sidebar disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[16px]" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
              {isTesting ? "Testing..." : "Test"}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenuAction(() => onCopy(displayModel, `model-${model.id}`))}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-main transition-colors hover:bg-sidebar"
          >
            <span className="material-symbols-outlined text-[16px]">{copied === `model-${model.id}` ? "check" : "content_copy"}</span>
            {copied === `model-${model.id}` ? "Copied" : "Copy model ID"}
          </button>
          {onEditAccessTags && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(onEditAccessTags)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-main transition-colors hover:bg-sidebar"
            >
              <span className={`material-symbols-outlined text-[16px] ${accessTags.length > 0 ? "text-violet-300" : "text-text-muted"}`}>sell</span>
              权限标签{accessTags.length > 0 ? ` (${accessTags.length})` : ""}
            </button>
          )}
          {isCustom && onDeleteAlias ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(onDeleteAlias)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10"
            >
              <span className="material-symbols-outlined text-[16px]">delete</span>
              Remove model
            </button>
          ) : onDisable ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(onDisable)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10"
            >
              <span className="material-symbols-outlined text-[16px]">block</span>
              Disable model
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
  accessTags: PropTypes.arrayOf(PropTypes.string),
  onEditAccessTags: PropTypes.func,
  onEditCapabilities: PropTypes.func,
  onToggleCapability: PropTypes.func,
  busyCapabilityKey: PropTypes.string,
  sourceLabel: PropTypes.string,
  selectable: PropTypes.bool,
  selected: PropTypes.bool,
  onToggleSelect: PropTypes.func,
};
