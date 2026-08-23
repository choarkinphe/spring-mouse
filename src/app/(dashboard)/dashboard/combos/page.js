"use client";

import { useState, useEffect, useCallback } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Badge, Card, Button, Drawer, Input, ModuleSkeleton, DashboardHero, ModelSelectModal, ConfirmModal, CapacityBadges, Tooltip, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

const DEFAULT_TIME_WINDOW = { start: "09:00", end: "18:00" };
const DEFAULT_MODEL_SCHEDULE = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  active: [{ ...DEFAULT_TIME_WINDOW }],
  inactive: [],
  activeEnabled: true,
  inactiveEnabled: false,
};

function getComboModelValue(entry) {
  return typeof entry === "object" && entry !== null ? String(entry.model || "") : String(entry || "");
}

function getScheduleTimeWindows(schedule, field) {
  const legacy = schedule?.start !== undefined || schedule?.end !== undefined;
  if (legacy && field === "active") {
    return Array.isArray(schedule.active) ? schedule.active : [{ start: schedule.start, end: schedule.end }];
  }
  if (legacy && field === "inactive") {
    return Array.isArray(schedule.inactive) ? schedule.inactive : [];
  }
  return Array.isArray(schedule?.[field]) ? schedule[field] : [];
}

function getEffectiveScheduleWindows(schedule, field) {
  if (!schedule) return [];
  const enabled = field === "active"
    ? schedule.activeEnabled !== false
    : schedule.inactiveEnabled === true;
  return enabled ? getScheduleTimeWindows(schedule, field) : [];
}

function getComboModelSchedule(entry) {
  if (typeof entry !== "object" || entry === null || !entry.schedule) return null;
  const schedule = entry.schedule;
  const timezone = schedule.timezone || "";
  const active = getScheduleTimeWindows(schedule, "active");
  const inactive = getScheduleTimeWindows(schedule, "inactive");
  return {
    ...(timezone ? { timezone } : {}),
    active,
    inactive,
    activeEnabled: schedule.activeEnabled !== false,
    inactiveEnabled: schedule.inactiveEnabled === true || (schedule.inactiveEnabled === undefined && inactive.length > 0),
  };
}

function isTimeWindowInvalid(window) {
  return !window?.start || !window?.end || window.start === window.end;
}

function isScheduleFieldInvalid(schedule, field) {
  if (!schedule) return false;
  const windows = getEffectiveScheduleWindows(schedule, field);
  if (windows.some(isTimeWindowInvalid)) return true;
  const keys = new Set();
  for (const window of windows) {
    const key = `${window.start}-${window.end}`;
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function isComboModelScheduleInvalid(schedule) {
  return ["active", "inactive"].some((field) => isScheduleFieldInvalid(schedule, field));
}

function getComboScheduleValidationError(models) {
  for (let i = 0; i < models.length; i++) {
    const entry = models[i];
    const model = getComboModelValue(entry);
    const schedule = getComboModelSchedule(entry);
    if (!schedule || !isComboModelScheduleInvalid(schedule)) continue;

    const field = ["active", "inactive"].find((f) => {
      const windows = getEffectiveScheduleWindows(schedule, f);
      if (windows.some(isTimeWindowInvalid)) return true;
      const keys = new Set();
      for (const window of windows) {
        const key = `${window.start}-${window.end}`;
        if (keys.has(key)) return true;
        keys.add(key);
      }
      return false;
    });
    const label = field === "active" ? "生效" : "失效";
    return `模型 ${model} 的${label}时段不完整或重复，请检查开始/结束时间`;
  }
  return null;
}

function formatTimeWindow(window) {
  if (!window?.start || !window?.end) return "未完成时段";
  return `${window.start}-${window.end}`;
}

function formatModelScheduleDetail(schedule) {
  const active = getEffectiveScheduleWindows(schedule, "active");
  const inactive = getEffectiveScheduleWindows(schedule, "inactive");
  return [
    "生效时段",
    active.length ? active.map((window) => `• ${formatTimeWindow(window)}`).join("\n") : "• 全天",
    "",
    "失效时段",
    inactive.length ? inactive.map((window) => `• ${formatTimeWindow(window)}`).join("\n") : "• 未配置",
  ].join("\n");
}

function formatModelScheduleSummary(schedule) {
  const active = getEffectiveScheduleWindows(schedule, "active");
  const inactive = getEffectiveScheduleWindows(schedule, "inactive");
  if (active.length === 0 && inactive.length === 0) return null;
  if (active.length === 0) return `${inactive.length} 个失效段`;
  if (inactive.length === 0) return `${active.length} 个生效段`;
  return `${active.length} 生效 / ${inactive.length} 失效`;
}

const EMPTY_COMBO_CAPABILITIES = {
  contextWindow: "",
  vision: false,
  audioInput: false,
};

function getComboCapabilities(capabilities) {
  const rawContextWindow = capabilities?.contextWindow;
  return {
    contextWindow: Number.isInteger(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : null,
    vision: capabilities?.vision === true,
    audioInput: capabilities?.audioInput === true,
  };
}

function formatContextWindowK(contextWindow) {
  if (!contextWindow) return null;
  const value = contextWindow / 1000;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))}k`;
}

export default function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const { getCaps } = useModelCaps();
  const [confirmState, setConfirmState] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = async () => {
    try {
      const [combosRes, providersRes, settingsRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
      ]);
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      
      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) setCombos((combosData.combos || []).filter(c => !c.kind || c.kind === "llm"));
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      setComboStrategies(settingsData.comboStrategies || {});
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (data) => {
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setShowCreateModal(false);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create combo");
      }
    } catch (error) {
      console.log("Error creating combo:", error);
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingCombo(null);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update combo");
      }
    } catch (error) {
      console.log("Error updating combo:", error);
    }
  };

  const handleToggleComboActive = async (id, isActive) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        const updated = await res.json();
        setCombos((current) => current.map((combo) => combo.id === id ? updated : combo));
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update combo status");
      }
    } catch (error) {
      console.log("Error updating combo status:", error);
    }
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Combo",
      message: "Delete this combo?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            setCombos(combos.filter(c => c.id !== id));
          }
        } catch (error) {
          console.log("Error deleting combo:", error);
        }
      }
    });
  };

  // Persist routing decisions on each combo. This keeps the visible selection
  // and runtime behavior aligned without relying on a hidden global default.
  const handleSetComboStrategy = async (comboName, patch) => {
    try {
      const updated = { ...comboStrategies };
      const next = { fallbackStrategy: "fallback", ...(updated[comboName] || {}), ...patch };

      if (patch.fallbackStrategy && patch.fallbackStrategy !== "round-robin") {
        delete next.stickyRoundRobinLimit;
      }
      if (patch.fallbackStrategy && patch.fallbackStrategy !== "fusion") {
        delete next.judgeModel;
      }

      updated[comboName] = next;

      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategies: updated }),
      });

      setComboStrategies(updated);
    } catch (error) {
      console.log("Error updating combo strategy:", error);
    }
  };

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
        <DashboardHero
          eyebrow="Model routing"
          title="路由策略"
          description="正在读取组合、策略与模型编排数据。"
          icon="route"
          action={<Button icon="add" disabled>新增模型组合</Button>}
        >
          <Badge variant="default" size="md" icon="progress_activity">正在加载组合</Badge>
        </DashboardHero>
        <ModuleSkeleton title="正在加载路由组合" icon="layers" lines={5} className="min-h-[270px]" />
        <ModuleSkeleton title="正在读取调度策略" icon="account_tree" lines={4} className="min-h-[180px]" />
      </div>
    );
  }

  const routedModelCount = combos.reduce((total, combo) => total + combo.models.length, 0);
  const fusionCount = combos.filter((combo) => (comboStrategies[combo.name]?.fallbackStrategy || "fallback") === "fusion").length;
  const groupOptions = [...new Set(combos.map((combo) => combo.groupName?.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const comboGroups = [];
  const groupIndex = new Map();
  for (const combo of combos) {
    const groupName = combo.groupName?.trim() || "未分组";
    let group = groupIndex.get(groupName);
    if (!group) {
      group = { name: groupName, combos: [] };
      groupIndex.set(groupName, group);
      comboGroups.push(group);
    }
    group.combos.push(combo);
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <DashboardHero
        eyebrow="Model routing"
        title="路由策略"
        description="将多个模型编排为稳定调用入口，并为每个组合指定清晰的调度方式。"
        icon="route"
        action={<Button icon="add" onClick={() => setShowCreateModal(true)}>新增模型组合</Button>}
      >
        <Badge variant="primary" size="md" icon="layers">{combos.length} 个模型组合</Badge>
        <Badge variant="default" size="md" icon="memory">{routedModelCount} 个路由节点</Badge>
        <Badge variant={fusionCount > 0 ? "info" : "default"} size="md" icon="account_tree">{fusionCount} 个融合策略</Badge>
      </DashboardHero>

      <section aria-labelledby="model-combos-heading" className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/[0.045] px-4 py-3">
          <span className="material-symbols-outlined mt-0.5 text-[19px] text-[#7dd3fc]">route</span>
          <div className="min-w-0">
            <h2 id="model-combos-heading" className="text-sm font-semibold text-text-main">组合如何调度</h2>
            <p className="mt-1 text-xs leading-5 text-text-muted"><span className="font-medium text-text-main">回退</span> 按顺序切换；<span className="font-medium text-text-main">轮询</span> 均匀分摊负载；<span className="font-medium text-text-main">融合</span> 并行调用并交由裁判模型汇总，质量更高但会产生 N+1 次调用。</p>
          </div>
        </div>

        {/* Combos List */}
        {combos.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg/20 px-6 text-center">
            <span className="material-symbols-outlined mb-3 text-[34px] text-[#647688]">layers</span>
            <h2 className="text-base font-semibold text-text-main">还没有模型组合</h2>
            <p className="mt-1 max-w-sm text-sm text-text-muted">新建一个组合后，即可为同一模型入口配置回退、轮询或融合策略。</p>
            <Button icon="add" className="mt-5" onClick={() => setShowCreateModal(true)}>新增模型组合</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {comboGroups.map((group) => (
              <section key={group.name} aria-label={`${group.name} 组合`} className="flex flex-col gap-3">
                <div className="flex items-center gap-2 px-1">
                  <span className="material-symbols-outlined text-[17px] text-[#7dd3fc]">folder</span>
                  <h3 className="text-sm font-semibold text-text-main">{group.name}</h3>
                  <span className="rounded-full border border-white/[0.08] bg-black/[0.12] px-1.5 py-0.5 text-[10px] text-text-muted">{group.combos.length}</span>
                </div>
                <div className="flex flex-col gap-4">
                  {group.combos.map((combo) => (
                    <ComboCard
                      key={combo.id}
                      combo={combo}
                      getCaps={getCaps}
                      activeProviders={activeProviders}
                      copied={copied}
                      onCopy={copy}
                      onEdit={() => setEditingCombo(combo)}
                      onDelete={() => handleDelete(combo.id)}
                      onToggleActive={(isActive) => handleToggleComboActive(combo.id, isActive)}
                      strategy={comboStrategies[combo.name] || {}}
                      onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      {/* Create Modal - Use key to force remount and reset state */}
      {showCreateModal && (
        <ComboFormModal
          key="create"
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreate}
          activeProviders={activeProviders}
          getCaps={getCaps}
          groupOptions={groupOptions}
        />
      )}

      {editingCombo && (
        <ComboFormModal
          key={editingCombo.id}
          isOpen={!!editingCombo}
          combo={editingCombo}
          onClose={() => setEditingCombo(null)}
          onSave={(data) => handleUpdate(editingCombo.id, data)}
          activeProviders={activeProviders}
          getCaps={getCaps}
          groupOptions={groupOptions}
        />
      )}

      {/* Confirm Delete Modal */}
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

const STRATEGY_OPTIONS = [
  { value: "fallback", label: "回退", description: "按模型顺序尝试，失败后切换到下一个", icon: "format_list_numbered" },
  { value: "round-robin", label: "轮询", description: "在模型之间轮换请求以分摊负载", icon: "sync" },
  { value: "fusion", label: "融合", description: "并行调用面板模型，并由裁判模型综合结果", icon: "account_tree" },
];

function ComboCard({ combo, getCaps, activeProviders = [], copied, onCopy, onEdit, onDelete, onToggleActive, strategy = {}, onSetStrategy }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const current = strategy.fallbackStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";
  const isActive = combo.isActive !== false;
  const roundRobinLimit = strategy.stickyRoundRobinLimit || 1;
  const exposedCapabilities = getComboCapabilities(combo.capabilities);

  const handleRoundRobinLimitChange = (value) => {
    const next = Number.parseInt(value, 10);
    if (Number.isFinite(next) && next > 0) onSetStrategy({ stickyRoundRobinLimit: next });
  };

  const activeStrategy = STRATEGY_OPTIONS.find((option) => option.value === current) || STRATEGY_OPTIONS[0];

  return (
    <section className="rounded-xl border border-border-subtle bg-surface/35">
      <div className="flex flex-col gap-3 border-b border-white/[0.065] bg-white/[0.018] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#38bdf8]/10 text-[#7dd3fc]">
            <span className="material-symbols-outlined text-[19px]">layers</span>
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm font-semibold text-text-main">{combo.name}</h2>
            <p className="mt-0.5 text-xs text-text-muted">{combo.models.length} 个模型 · {isActive ? `当前使用${activeStrategy.label}策略` : "已禁用，不参与路由"}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span className="rounded-md border border-white/[0.08] bg-black/[0.12] px-2 py-1">{combo.models.length} 个节点</span>
          <span className="rounded-md border border-white/[0.08] bg-black/[0.12] px-2 py-1" title="数值越小越靠前">排序 {combo.sortOrder ?? 0}</span>
          <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-black/[0.12] px-2 py-1" title={isActive ? "禁用组合" : "启用组合"}>
            <span className={`text-[11px] ${isActive ? "text-emerald-200" : "text-text-muted"}`}>{isActive ? "已启用" : "已禁用"}</span>
            <Toggle checked={isActive} onChange={onToggleActive} size="sm" />
          </div>
          <span className="rounded-md border border-[#38bdf8]/15 bg-[#38bdf8]/[0.06] px-2 py-1 text-[#bae6fd]">{activeStrategy.label}</span>
          {isFusion && <span className="rounded-md border border-violet-400/15 bg-violet-400/[0.06] px-2 py-1 text-violet-200">裁判已配置</span>}
        </div>
      </div>

      <div className="hidden grid-cols-[minmax(20rem,1.4fr)_minmax(17rem,0.9fr)_7rem] gap-6 border-b border-white/[0.065] px-4 py-2 text-[10px] font-mono uppercase tracking-[0.15em] text-[#647688] lg:grid">
        <span>模型节点</span>
        <span className="border-l border-white/[0.065] pl-6">调度策略</span>
        <span className="text-center">操作</span>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 px-4 py-4 transition-colors hover:bg-[#38bdf8]/[0.035] lg:grid-cols-[minmax(20rem,1.4fr)_minmax(17rem,0.9fr)_7rem] lg:items-center lg:gap-6">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-start gap-1.5">
            {combo.models.length === 0 ? (
              <span className="text-xs italic text-text-muted">尚未添加模型</span>
            ) : (
              combo.models.map((entry, index) => {
                const model = getComboModelValue(entry);
                const schedule = getComboModelSchedule(entry);
                const summary = schedule ? formatModelScheduleSummary(schedule) : null;
                return (
                  <span
                    key={`${model}-${index}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/[0.05] bg-black/[0.04] px-2 py-1 dark:bg-white/[0.03]"
                    title={summary ? `已配置 ${summary}` : undefined}
                  >
                    <code className="truncate font-mono text-[11px] text-[#c5d4e2]">{model}</code>
                    <CapacityBadges caps={getCaps?.(model)} />
                    {summary && (
                      <Tooltip text={formatModelScheduleDetail(schedule)} position="top">
                        <span
                          className="shrink-0 rounded-full border border-[#38bdf8]/25 bg-[#38bdf8]/10 px-1.5 py-0 text-[9px] font-medium text-[#7dd3fc]"
                          aria-label={`时段明细：${formatModelScheduleDetail(schedule).replace("\n", "，")}`}
                        >
                          {summary}
                        </span>
                      </Tooltip>
                    )}
                  </span>
                );
              })
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="font-medium text-text-muted">对外声明</span>
            {exposedCapabilities.contextWindow && <span className="rounded border border-white/[0.08] bg-black/[0.12] px-1.5 py-0.5 font-mono text-[#c5d4e2]">{formatContextWindowK(exposedCapabilities.contextWindow)} ctx</span>}
            {exposedCapabilities.vision && <span className="inline-flex items-center gap-0.5 rounded border border-[#38bdf8]/20 bg-[#38bdf8]/[0.06] px-1.5 py-0.5 text-[#7dd3fc]"><span className="material-symbols-outlined text-[12px]">visibility</span>视觉</span>}
            {exposedCapabilities.audioInput && <span className="inline-flex items-center gap-0.5 rounded border border-violet-400/20 bg-violet-400/[0.06] px-1.5 py-0.5 text-violet-200"><span className="material-symbols-outlined text-[12px]">graphic_eq</span>音频</span>}
            {!exposedCapabilities.contextWindow && !exposedCapabilities.vision && !exposedCapabilities.audioInput && <span className="text-text-muted">未声明</span>}
          </div>
          {isFusion && (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium text-text-muted">裁判模型</span>
              <button onClick={() => setShowJudgeSelect(true)} className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary transition-colors hover:border-primary hover:bg-primary/5" title="选择用于汇总结果的裁判模型">
                <span className="material-symbols-outlined text-[13px]">gavel</span>
                <span className="truncate">{judge || "自动 · 第一个当前可用模型"}</span>
              </button>
              {judge && <button onClick={() => onSetStrategy({ judgeModel: "" })} className="rounded p-0.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500" title="恢复自动选择"><span className="material-symbols-outlined text-[13px]">close</span></button>}
            </div>
          )}
        </div>

        <div className="min-w-0 border-t border-white/[0.065] pt-3 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={`${combo.name} routing strategy`}>
            {STRATEGY_OPTIONS.map((option) => {
              const selected = current === option.value;
              return (
                <button key={option.value} type="button" role="radio" aria-checked={selected} onClick={() => onSetStrategy({ fallbackStrategy: option.value })} title={option.description} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${selected ? "border-[#38bdf8]/35 bg-[#38bdf8]/[0.09] text-[#7dd3fc]" : "border-white/[0.08] bg-black/[0.1] text-text-muted hover:border-[#38bdf8]/30 hover:text-text-main"}`}>
                  <span className="material-symbols-outlined text-[14px]">{option.icon}</span>{option.label}
                </button>
              );
            })}
          </div>
          {current === "round-robin" && (
            <label className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-black/[0.12] px-2 py-1 text-[11px] text-text-muted">
              <span>每模型</span><input type="number" min="1" value={roundRobinLimit} onChange={(event) => handleRoundRobinLimitChange(event.target.value)} className="w-7 bg-transparent text-center font-mono text-[11px] text-text-main outline-none" aria-label={`${combo.name} 每个模型的轮询次数`} /><span>次</span>
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-1 border-t border-white/[0.065] pt-3 lg:border-0 lg:pt-0">
          <button onClick={(event) => { event.stopPropagation(); onCopy(combo.name, `combo-${combo.id}`); }} className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]" title="复制组合名称" aria-label="复制组合名称"><span className="material-symbols-outlined text-[18px]">{copied === `combo-${combo.id}` ? "check" : "content_copy"}</span></button>
          <button onClick={onEdit} className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]" title="编辑组合" aria-label="编辑组合"><span className="material-symbols-outlined text-[18px]">edit</span></button>
          <button onClick={onDelete} className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400" title="删除组合" aria-label="删除组合"><span className="material-symbols-outlined text-[18px]">delete</span></button>
        </div>
      </div>

      {showJudgeSelect && (
        <ModelSelectModal isOpen={showJudgeSelect} onClose={() => setShowJudgeSelect(false)} onSelect={(model) => { onSetStrategy({ judgeModel: model?.value || "" }); setShowJudgeSelect(false); }} activeProviders={activeProviders} title="选择裁判模型" addedModelValues={judge ? [judge] : []} closeOnSelect />
      )}
    </section>
  );
}

function ScheduleWindowSection({
  model,
  schedule,
  field,
  label,
  tone,
  toneBorder,
  expanded,
  enabled,
  onToggle,
  onSetEnabled,
  onAdd,
  onPatch,
  onRemove,
}) {
  const windows = getScheduleTimeWindows(schedule, field);
  const invalid = isScheduleFieldInvalid(schedule, field);
  const timeInputClass = (window) => [
    "h-7 w-[4.5rem] shrink-0 rounded-md border bg-white px-1.5 py-0.5 font-mono text-[10px] text-text-main outline-none transition-colors focus:border-primary dark:bg-black/20",
    isTimeWindowInvalid(window) ? "border-red-400/60" : "border-black/10 dark:border-white/10",
  ].join(" ");

  return (
    <section className={`flex min-w-0 flex-col overflow-hidden rounded-md border ${toneBorder} bg-black/[0.012] dark:bg-white/[0.008]`}>
      <div className="flex min-w-0 items-center justify-between gap-2 px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <span className={`material-symbols-outlined shrink-0 text-[14px] transition-transform ${expanded ? "rotate-90" : ""}`}>
            chevron_right
          </span>
          <span className={`text-[10px] font-medium ${tone}`}>{label}</span>
          {windows.length > 0 && (
            <span className="rounded-full border border-white/10 bg-black/[0.08] px-1 py-0 text-[9px] text-text-muted dark:bg-white/[0.08]">
              {windows.length}
            </span>
          )}
        </button>
        <Toggle checked={enabled} onChange={(next) => onSetEnabled(next)} size="sm" />
      </div>

      {expanded && enabled && (
        <div className="flex min-w-0 flex-col gap-1 border-t border-black/5 px-2 pb-1.5 pt-1 dark:border-white/5">
          {windows.length === 0 ? (
            <span className="text-[10px] text-text-muted">
              {field === "active" ? "未配置，表示全天可用" : "未配置失效时段"}
            </span>
          ) : (
            windows.map((window, index) => (
              <div key={`${field}-${index}`} className="flex min-w-0 items-center gap-1.5">
                <input
                  type="time"
                  value={window.start || ""}
                  onChange={(e) => onPatch(index, { start: e.target.value })}
                  className={timeInputClass(window)}
                  aria-label={`${model} ${label}开始时间`}
                />
                <span className="shrink-0 text-[10px] text-text-muted">—</span>
                <input
                  type="time"
                  value={window.end || ""}
                  onChange={(e) => onPatch(index, { end: e.target.value })}
                  className={timeInputClass(window)}
                  aria-label={`${model} ${label}结束时间`}
                />
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-black/10 text-text-muted transition-colors hover:border-red-400/50 hover:bg-red-500/10 hover:text-red-500 dark:border-white/10"
                  title={`移除${label}`}
                  aria-label={`移除${label}`}
                >
                  <span className="material-symbols-outlined text-[13px]">close</span>
                </button>
              </div>
            ))
          )}
          {enabled && (
            <button
              type="button"
              onClick={onAdd}
              className="flex h-6 w-full shrink-0 items-center justify-center rounded-md border border-dashed border-primary/35 text-primary transition-colors hover:border-primary hover:bg-primary/5"
              title={`添加${label}`}
              aria-label={`添加${label}`}
            >
              <span className="material-symbols-outlined text-[15px]">add</span>
            </button>
          )}
          {invalid && (
            <span className="text-[10px] font-medium text-red-400">
              开始和结束时间必须不同，且不能重复添加相同时段
            </span>
          )}
        </div>
      )}

      {expanded && !enabled && (
        <div className="flex min-w-0 flex-col gap-1 border-t border-black/5 px-2 py-1.5 dark:border-white/5">
          <span className="text-[10px] text-text-muted">
            {field === "active" ? "已停用，当前不按生效时段限制" : "已停用，当前无失效时段"}
          </span>
        </div>
      )}
    </section>
  );
}

function ModelItem({ id, index, entry, isFirst, isLast, onEdit, onScheduleChange, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const model = getComboModelValue(entry);
  const schedule = getComboModelSchedule(entry);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  const [expanded, setExpanded] = useState(!!schedule);
  const [expandedSections, setExpandedSections] = useState({ active: true, inactive: false });

  const patchSchedule = (patch) => onScheduleChange({ ...schedule, ...patch });

  const patchWindow = (field, index, patch) => {
    const windows = getScheduleTimeWindows(schedule, field);
    const next = windows.map((window, i) => i === index ? { ...window, ...patch } : window);
    onScheduleChange({ ...schedule, [field]: next });
  };

  const addWindow = (field) => {
    const windows = getScheduleTimeWindows(schedule, field);
    onScheduleChange({
      ...schedule,
      [`${field}Enabled`]: true,
      [field]: [...windows, { ...DEFAULT_TIME_WINDOW }],
    });
    setExpandedSections((current) => ({ ...current, [field]: true }));
  };

  const removeWindow = (field, index) => {
    onScheduleChange({
      ...schedule,
      [field]: getScheduleTimeWindows(schedule, field).filter((_, i) => i !== index),
    });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          {...attributes}
          {...listeners}
          type="button"
          className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
          title="Drag to reorder"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
            <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
            <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
          </svg>
        </button>

        <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>

        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
          />
        ) : (
          <div
            className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-sm font-semibold text-text-main hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => setEditing(true)}
            title="Click to edit"
          >
            {model}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
            title="Move up"
          >
            <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
            title="Move down"
          >
            <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
          </button>
          <button
            onClick={onRemove}
            className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
            title="Remove"
          >
            <span className="material-symbols-outlined text-[12px]">close</span>
          </button>
        </div>
      </div>

      <div className="ml-8 flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!schedule) onScheduleChange({ ...DEFAULT_MODEL_SCHEDULE });
            setExpanded((v) => !v);
          }}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-primary transition-colors hover:text-primary/80"
        >
          <span className="material-symbols-outlined text-[13px]">
            {expanded ? "expand_less" : "expand_more"}
          </span>
          高级选项
        </button>
        {schedule && (
          <span className="truncate text-[10px] text-text-muted">
            {formatModelScheduleSummary(schedule) || "已配置时段"}
          </span>
        )}
      </div>

      {expanded && (
        <div className="ml-8 flex min-w-0 flex-col gap-2 rounded-lg border border-black/5 bg-black/[0.015] p-2.5 dark:border-white/5 dark:bg-white/[0.015]">
          {schedule ? (
            <>
              <ScheduleWindowSection
                model={model}
                schedule={schedule}
                field="active"
                label="生效时段"
                tone="text-[#7dd3fc]"
                toneBorder="border-[#38bdf8]/15"
                expanded={expandedSections.active}
                enabled={schedule.activeEnabled !== false}
                onToggle={() => setExpandedSections((current) => ({ ...current, active: !current.active }))}
                onSetEnabled={(enabled) => onScheduleChange({ ...schedule, activeEnabled: enabled })}
                onAdd={() => addWindow("active")}
                onPatch={(index, patch) => patchWindow("active", index, patch)}
                onRemove={(index) => removeWindow("active", index)}
              />
              <ScheduleWindowSection
                model={model}
                schedule={schedule}
                field="inactive"
                label="失效时段"
                tone="text-red-300"
                toneBorder="border-red-400/15"
                expanded={expandedSections.inactive}
                enabled={schedule.inactiveEnabled === true}
                onToggle={() => setExpandedSections((current) => ({ ...current, inactive: !current.inactive }))}
                onSetEnabled={(enabled) => onScheduleChange({ ...schedule, inactiveEnabled: enabled })}
                onAdd={() => addWindow("inactive")}
                onPatch={(index, patch) => patchWindow("inactive", index, patch)}
                onRemove={(index) => removeWindow("inactive", index)}
              />
              <div className="flex min-w-0 items-center justify-between">
                <p className="text-[10px] leading-4 text-text-muted">
                  生效时段为空表示全天可用；命中任意失效时段时不参与路由。支持跨午夜，例如 22:00-06:00。
                </p>
                <button
                  type="button"
                  onClick={() => onScheduleChange(null)}
                  className="shrink-0 text-[10px] text-text-muted underline transition-colors hover:text-red-400"
                >
                  清除时段配置
                </button>
              </div>
            </>
          ) : (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[10px] text-text-muted">尚未配置时段，当前模型全天参与路由。</span>
              <button
                type="button"
                onClick={() => onScheduleChange({ ...DEFAULT_MODEL_SCHEDULE })}
                className="w-fit rounded-md border border-dashed border-primary/40 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/5"
              >
                添加默认时段
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, getCaps, groupOptions = [], kindFilter = null }) {
  // Initialize state with combo values - key prop on parent handles reset on remount
  const [name, setName] = useState(combo?.name || "");
  const [models, setModels] = useState(combo?.models || []);
  const [groupName, setGroupName] = useState(combo?.groupName || "");
  const [sortOrder, setSortOrder] = useState(String(combo?.sortOrder ?? 0));
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const savedCapabilities = getComboCapabilities(combo?.capabilities);
  const [capabilities, setCapabilities] = useState({
    ...EMPTY_COMBO_CAPABILITIES,
    contextWindow: savedCapabilities.contextWindow ? String(savedCapabilities.contextWindow / 1000) : "",
    vision: savedCapabilities.vision,
    audioInput: savedCapabilities.audioInput,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Use stable index-based IDs so duplicates and similar names are handled correctly
  const modelValues = models.map(getComboModelValue);
  const modelItems = models.map((entry, i) => ({ uid: `item-${i}`, entry }));
  const capableMembers = {
    vision: models.filter((entry) => getCaps?.(getComboModelValue(entry))?.vision === true),
    audioInput: models.filter((entry) => getCaps?.(getComboModelValue(entry))?.audioInput === true),
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setModels((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  const fetchModalData = async () => {
    try {
      const aliasesRes = await fetch("/api/models/alias");
      if (!aliasesRes.ok) return;
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
    } catch (error) {
      console.error("Error fetching modal data:", error);
    }
  };

  useEffect(() => {
    if (isOpen) fetchModalData();
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError("Name is required");
      return false;
    }
    if (!VALID_NAME_REGEX.test(value)) {
      setNameError("Only letters, numbers, -, _ and . allowed");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!modelValues.includes(model.value)) {
      setModels([...models, model.value]);
    }
  };

  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => getComboModelValue(m) !== model.value));
  };

  const handleRemoveModel = (index) => {
    setModels(models.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newModels = [...models];
    [newModels[index - 1], newModels[index]] = [newModels[index], newModels[index - 1]];
    setModels(newModels);
  };

  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const newModels = [...models];
    [newModels[index], newModels[index + 1]] = [newModels[index + 1], newModels[index]];
    setModels(newModels);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    const scheduleError = getComboScheduleValidationError(models);
    if (scheduleError) {
      alert(scheduleError);
      return;
    }
    const normalizedSortOrder = Number(sortOrder || 0);
    if (!Number.isInteger(normalizedSortOrder)) {
      alert("排序值必须是整数");
      return;
    }
    const contextWindowK = capabilities.contextWindow.trim() === "" ? null : Number(capabilities.contextWindow);
    if (contextWindowK !== null && (!Number.isFinite(contextWindowK) || contextWindowK <= 0)) {
      alert("对外上下文窗口必须是大于 0 的 K 值");
      return;
    }
    const contextWindow = contextWindowK === null ? null : Math.round(contextWindowK * 1000);
    for (const [key, label] of [["vision", "视觉"], ["audioInput", "音频输入"]]) {
      if (capabilities[key] && capableMembers[key].length === 0) {
        alert(`组合声明支持${label}时，至少需要添加一个支持${label}的模型节点`);
        return;
      }
    }
    setSaving(true);
    await onSave({
      name: name.trim(),
      models,
      groupName: groupName.trim() || null,
      sortOrder: normalizedSortOrder,
      capabilities: { contextWindow, vision: capabilities.vision, audioInput: capabilities.audioInput },
    });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Drawer
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? "Edit Combo" : "Create Combo"}
        width="lg"
      >
        <div className="flex flex-col gap-3">
          <section className="rounded-lg border border-[#38bdf8]/15 bg-[#38bdf8]/[0.035] p-3">
            <div className="flex items-start gap-2.5">
              <span className="material-symbols-outlined mt-0.5 text-[18px] text-[#7dd3fc]">tune</span>
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-text-main">组合配置</h3>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">维护组合名称、分组、排序与对外能力声明。</p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Input label="组合名称" value={name} onChange={handleNameChange} placeholder="my-combo" error={nameError} />
                <p className="mt-0.5 text-[10px] text-text-muted">仅支持字母、数字、`-`、`_` 与 `.`</p>
              </div>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium text-text-main">分组（可选）</span>
                <input list="combo-group-options" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="选择已有分组或输入新分组" maxLength={64} className="h-9 w-full rounded-md border border-black/10 bg-white px-2 text-sm text-text-main outline-none transition-colors focus:border-primary dark:border-white/10 dark:bg-black/20" />
                <datalist id="combo-group-options">
                  {groupOptions.map((group) => <option key={group} value={group} />)}
                </datalist>
                <span className="text-[10px] text-text-muted">可选择已有分组，也可直接新建。</span>
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium text-text-main">排序值</span>
                <input type="number" step="1" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} className="h-9 w-full rounded-md border border-black/10 bg-white px-2 font-mono text-sm text-text-main outline-none transition-colors focus:border-primary dark:border-white/10 dark:bg-black/20" />
                <span className="text-[10px] text-text-muted">数值越小，组合越靠前。</span>
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium text-text-main">对外上下文窗口</span>
                <div className="flex h-9 items-center rounded-md border border-black/10 bg-white px-2 dark:border-white/10 dark:bg-black/20">
                  <input type="number" min="0.001" step="0.001" inputMode="decimal" value={capabilities.contextWindow} onChange={(event) => setCapabilities((current) => ({ ...current, contextWindow: event.target.value }))} placeholder="例如 128" className="min-w-0 flex-1 bg-transparent font-mono text-sm text-text-main outline-none" aria-label="对外上下文窗口（K）" />
                  <span className="shrink-0 text-[11px] text-text-muted">K</span>
                </div>
                <span className="text-[10px] text-text-muted">1K = 1,000 tokens；留空表示不声明。</span>
              </label>
            </div>

            <div className="mt-3 flex items-center gap-1.5 border-t border-[#38bdf8]/10 pt-3">
              <span className="mr-1 text-[11px] text-text-muted">输入能力</span>
              {[["vision", "视觉输入", "visibility"], ["audioInput", "音频输入", "graphic_eq"]].map(([key, label, icon]) => {
                const supportedCount = capableMembers[key].length;
                const enabled = capabilities[key];
                return (
                  <button key={key} type="button" onClick={() => setCapabilities((current) => ({ ...current, [key]: !current[key] }))} aria-pressed={enabled} aria-label={`${label}${enabled ? "已声明" : "未声明"}`} title={`${label}${enabled ? "：已声明" : "：未声明"}；当前有 ${supportedCount} 个可承接节点`} className={`inline-flex size-8 items-center justify-center rounded-md border transition-colors ${enabled ? "border-[#38bdf8]/35 bg-[#38bdf8]/[0.1] text-[#7dd3fc]" : "border-white/[0.08] bg-black/[0.12] text-text-muted hover:border-[#38bdf8]/30 hover:text-text-main"}`}>
                    <span className="material-symbols-outlined text-[17px]">{icon}</span>
                  </button>
                );
              })}
              <span className="ml-1 text-[10px] text-text-muted">声明后需至少保留一个可承接节点。</span>
            </div>
          </section>

          {/* Models */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Models</label>
            <p className="mb-1.5 text-[10px] text-text-muted">未开启时段控制的模型始终参与路由；可配置多个每日生效/失效时段，失效优先，并支持跨午夜。</p>

            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                <div className="flex min-w-0 flex-col gap-1">
                  {modelItems.map(({ uid, entry }, index) => (
                    <ModelItem
                      key={uid}
                      id={uid}
                      index={index}
                      entry={entry}
                      isFirst={index === 0}
                      isLast={index === modelItems.length - 1}
                      onEdit={(newVal) => {
                        const updated = [...models];
                        updated[index] = typeof models[index] === "object" && models[index] !== null
                          ? { ...models[index], model: newVal }
                          : newVal;
                        setModels(updated);
                      }}
                      onScheduleChange={(schedule) => {
                        const updated = [...models];
                        const model = getComboModelValue(updated[index]);
                        updated[index] = schedule ? { model, schedule } : model;
                        setModels(updated);
                      }}
                      onMoveUp={() => handleMoveUp(index)}
                      onMoveDown={() => handleMoveDown(index)}
                      onRemove={() => handleRemoveModel(index)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            )}

            {/* Add Model button */}
            <button
              onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={!name.trim() || !!nameError || saving}
            >
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Drawer>

      {/* Model selector opens as a second-layer drawer above the combo editor. */}
      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add Model to Combo"
          kindFilter={kindFilter}
          addedModelValues={modelValues}
          closeOnSelect={false}
          presentation="drawer"
          drawerWidth="lg"
        />
      )}
    </>
  );
}
