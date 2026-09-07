"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, caps, thinkingSuffix, accessTags = [], onEditAccessTags }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border-subtle";
  const statusIcon = testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy";
  const statusColor = testStatus === "ok" ? "text-green-500" : testStatus === "error" ? "text-red-500" : "text-text-muted";
  const modelType = isCustom ? "Custom" : isFree ? "Free" : "LLM";

  const runMenuAction = (action) => {
    setMenuOpen(false);
    action?.();
  };

  return (
    <article className={`group relative min-w-0 rounded-xl border ${borderColor} bg-bg/30 transition-colors hover:border-primary/35 hover:bg-sidebar/45`}>
      <header className="flex min-h-[52px] min-w-0 items-start gap-2 border-b border-border-subtle px-3 py-2.5">
        <span className={`material-symbols-outlined mt-0.5 shrink-0 text-[18px] ${statusColor}`}>
          {statusIcon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-sm font-semibold leading-5 text-text-main" title={model.id}>{model.id}</p>
          {alias && <p className="mt-0.5 truncate font-mono text-[10px] text-primary/75" title={alias}>Alias: {alias}</p>}
        </div>
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
      </header>

      <div className="min-w-0 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-sidebar px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{modelType}</span>
          {model.name && model.name !== model.id && (
            <span className="min-w-0 flex-1 truncate text-[10px] italic text-text-muted/70" title={model.name}>{model.name}</span>
          )}
          <CapacityBadges caps={caps} colorOverride="text-text-muted/70" size={13} />
        </div>
        <code className="mt-2 block truncate rounded-md bg-sidebar px-2 py-1.5 font-mono text-[10px] text-text-muted" title={displayModel}>{displayModel}</code>
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
};
