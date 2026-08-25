"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import { comboMemberModel } from "../chatDebugLib.js";

// Grouped picker over the routing-strategy (combo) config:
// - 「策略」: the combo itself (bare name → full strategy incl. account fallback)
// - 「策略成员模型」: each member alias/model (direct hit, skips combo logic)
function ModelPicker({ combos, loading, value, onChange, getCaps }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleMouseDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  const activeLlmCombos = useMemo(
    () => (combos || []).filter((c) => c && c.kind !== "webSearch" && c.kind !== "webFetch" && c.isActive !== false)
      .sort((a, b) => String(a.groupName || "").localeCompare(String(b.groupName || "")) || String(a.name || "").localeCompare(String(b.name || ""))),
    [combos],
  );

  const memberModels = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const combo of activeLlmCombos) {
      for (const member of combo.models || []) {
        const model = comboMemberModel(member);
        if (!model || seen.has(model)) continue;
        seen.add(model);
        list.push(model);
      }
    }
    return list.sort((a, b) => a.localeCompare(b));
  }, [activeLlmCombos]);

  const selectedCombo = activeLlmCombos.find((c) => c.name === value) || null;
  const isMember = !selectedCombo && memberModels.includes(value);
  const label = selectedCombo ? `策略 · ${selectedCombo.name}` : isMember ? value : "选择模型";

  const renderVisionBadge = (hasVision) =>
    hasVision ? <Badge variant="info" size="sm">视觉</Badge> : null;

  const renderCheck = (active) =>
    active ? <span className="material-symbols-outlined text-brand-600 text-[16px]">check</span> : null;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={loading}
        className="flex h-8 max-w-[16rem] items-center gap-1 rounded-full px-2.5 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-main disabled:opacity-60"
        title={value || "选择模型"}
      >
        <span className="material-symbols-outlined text-[16px]">swap_horiz</span>
        <span className="truncate">{label}</span>
        <span className={`material-symbols-outlined text-[16px] transition-transform ${open ? "rotate-180" : ""}`}>expand_more</span>
      </button>

      {open ? (
        <div className="custom-scrollbar absolute bottom-[calc(100%+6px)] left-0 z-30 max-h-[60vh] w-[min(26rem,70vw)] overflow-y-auto rounded-xl border border-border bg-surface shadow-lg">
          {loading ? (
            <div className="px-3 py-4 text-sm text-text-muted">加载路由策略中…</div>
          ) : activeLlmCombos.length === 0 ? (
            <div className="px-3 py-4 text-sm text-text-muted">暂无活跃的 LLM 路由策略，请先在「路由策略」中配置。</div>
          ) : (
            <>
              <div className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-text-muted">策略</div>
              {activeLlmCombos.map((combo) => (
                <button
                  key={`combo-${combo.id || combo.name}`}
                  type="button"
                  onClick={() => { onChange(combo.name); setOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-main transition-colors hover:bg-surface-2"
                >
                  <span className="material-symbols-outlined text-[16px] text-text-muted">route</span>
                  <span className="min-w-0 flex-1 truncate">{combo.name}</span>
                  <span className="shrink-0 text-xs text-text-muted">{(combo.models || []).length} 个成员</span>
                  {renderVisionBadge(combo.capabilities?.vision === true)}
                  {renderCheck(value === combo.name)}
                </button>
              ))}

              <div className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-text-muted">策略成员模型</div>
              {memberModels.length === 0 ? (
                <div className="px-3 pb-3 text-sm text-text-muted">策略中暂无成员模型。</div>
              ) : (
                memberModels.map((model) => {
                  const caps = getCaps ? getCaps(model) : null;
                  const context = caps?.contextWindow ? `${Math.round(caps.contextWindow / 1000)}k` : "";
                  return (
                    <button
                      key={`member-${model}`}
                      type="button"
                      onClick={() => { onChange(model); setOpen(false); }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-main transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{model}</span>
                      {context ? <span className="shrink-0 text-xs text-text-muted">{context}</span> : null}
                      {renderVisionBadge(caps?.vision === true)}
                      {renderCheck(value === model)}
                    </button>
                  );
                })
              )}
              <div className="h-2" />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

ModelPicker.propTypes = {
  combos: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string.isRequired,
    kind: PropTypes.string,
    isActive: PropTypes.bool,
    groupName: PropTypes.string,
    models: PropTypes.array,
    capabilities: PropTypes.shape({ vision: PropTypes.bool }),
  })),
  loading: PropTypes.bool,
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  getCaps: PropTypes.func,
};

export default ModelPicker;
