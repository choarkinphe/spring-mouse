"use client";

import { useState, useEffect, useCallback } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { AccessTagsEditor, Badge, Card, Button, Drawer, Input, ModuleSkeleton, DashboardHero, ModelSelectModal, ConfirmModal, CapacityBadges, Tooltip, Toggle } from "@/shared/components";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { normalizeAccessTags } from "@/shared/utils/accessTags";
import { COMBO_SEARCH_MODE, COMBO_SEARCH_MAX_RESULTS, getComboSearchProviders, getComboSearchValidationError } from "open-sse/services/comboSearch.js";

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

function getComboModelAccessTags(entry) {
  return typeof entry === "object" && entry !== null ? normalizeAccessTags(entry.accessTags) : [];
}

// The three tiers as sections of the node list, in the order a turn escalates:
// the classifier says "simple" and the fast section answers, "complex" and the
// strong section does. A tier is a routing destination, so it reads as a group
// with its own members rather than as a property of each node.
const AUTO_TIER_GROUPS = [
  {
    value: "fast",
    label: "快速",
    icon: "bolt",
    tone: "text-emerald-300",
    titleTone: "text-emerald-100",
    hint: "简单任务走这里",
  },
  {
    value: "balanced",
    label: "均衡",
    icon: "balance",
    tone: "text-[#7dd3fc]",
    titleTone: "text-[#bae6fd]",
    hint: "普通任务走这里",
  },
  {
    value: "strong",
    label: "强力",
    icon: "local_fire_department",
    tone: "text-amber-300",
    titleTone: "text-amber-100",
    hint: "复杂任务走这里",
  },
];

const AUTO_TIER_GROUP_LABELS = Object.fromEntries(AUTO_TIER_GROUPS.map((group) => [group.value, group.label]));

function getComboModelAutoTier(entry) {
  return typeof entry === "object" && entry !== null && ["fast", "balanced", "strong"].includes(entry.autoTier)
    ? entry.autoTier
    : "balanced";
}

const EFFORT_OPTIONS = [
  { value: "", label: "跟随请求" },
  { value: "none", label: "关闭" },
  { value: "minimal", label: "最少" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
];

const MIN_MEMBER_WEIGHT = 1;
const MAX_MEMBER_WEIGHT = 1000;

/**
 * Build the stored node from its parts, collapsing back to a plain string when
 * nothing is configured — that keeps existing rows byte-identical and makes
 * "no options" unambiguous.
 */
function buildComboModelEntry(model, schedule, accessTags, autoTier = "balanced", { effort = null, weight = 1 } = {}) {
  const normalizedTags = normalizeAccessTags(accessTags);
  const normalizedTier = ["fast", "balanced", "strong"].includes(autoTier) ? autoTier : "balanced";
  const normalizedEffort = EFFORT_OPTIONS.some((option) => option.value === effort) ? effort : null;
  const parsedWeight = Number.parseInt(weight, 10);
  const normalizedWeight = Number.isFinite(parsedWeight)
    ? Math.min(MAX_MEMBER_WEIGHT, Math.max(MIN_MEMBER_WEIGHT, parsedWeight))
    : MIN_MEMBER_WEIGHT;
  const plain = !schedule && normalizedTags.length === 0 && normalizedTier === "balanced"
    && !normalizedEffort && normalizedWeight === MIN_MEMBER_WEIGHT;
  if (plain) return model;
  return {
    model,
    ...(schedule ? { schedule } : {}),
    ...(normalizedTags.length > 0 ? { accessTags: normalizedTags } : {}),
    ...(normalizedTier !== "balanced" ? { autoTier: normalizedTier } : {}),
    ...(normalizedEffort ? { effort: normalizedEffort } : {}),
    ...(normalizedWeight !== MIN_MEMBER_WEIGHT ? { weight: normalizedWeight } : {}),
  };
}

/** Read a node's editable parts without losing fields this UI does not show. */
function comboModelEntryParts(entry) {
  return {
    schedule: getComboModelSchedule(entry),
    accessTags: getComboModelAccessTags(entry),
    autoTier: getComboModelAutoTier(entry),
    effort: typeof entry === "object" && entry !== null ? (entry.effort || null) : null,
    weight: typeof entry === "object" && entry !== null && Number.isInteger(entry.weight) ? entry.weight : MIN_MEMBER_WEIGHT,
  };
}

function rebuildComboModelEntry(entry, patch = {}) {
  const model = getComboModelValue(entry);
  const parts = { ...comboModelEntryParts(entry), ...patch };
  return buildComboModelEntry(model, parts.schedule, parts.accessTags, parts.autoTier, {
    effort: parts.effort,
    weight: parts.weight,
  });
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
  // Templates describe what could be built from THIS install's connected
  // providers; the server computes them so the dashboard and the runtime agree
  // on what "routable" means.
  const [templates, setTemplates] = useState([]);
  const [creatingTemplate, setCreatingTemplate] = useState(null);
  const [modelAliases, setModelAliases] = useState({});
  const [savingModels, setSavingModels] = useState(false);
  const { getCaps } = useModelCaps(combos);
  const [confirmState, setConfirmState] = useState(null);
  // Master-detail selection. `null` means "follow the first combo", so deleting
  // the selected row falls back to the head of the list without needing an effect.
  const [activeComboId, setActiveComboId] = useState(null);

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/api/models/alias")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => data && setModelAliases(data.aliases || {}))
      .catch((error) => console.log("Error fetching model aliases:", error));
  }, []);

  const fetchData = async () => {
    try {
      const [combosRes, providersRes, settingsRes, templatesRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/combo-templates"),
      ]);
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      // Templates are optional: a failure here must not block the page.
      const templatesData = templatesRes.ok ? await templatesRes.json().catch(() => null) : null;

      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) setCombos((combosData.combos || []).filter(c => !c.kind || c.kind === "llm"));
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      setComboStrategies(settingsData.comboStrategies || {});
      if (templatesData?.templates) setTemplates(templatesData.templates);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * One-click create from a template.
   *
   * A template creates an ordinary combo: the members it picked, plus a
   * strategy that matches what the template is FOR (smart and thrifty lean on
   * the existing auto tiers, steady is plain ordered fallback). Nothing here is
   * a special combo kind, so every later edit works as usual.
   */
  const handleCreateFromTemplate = async (template, { editAfter = false } = {}) => {
    if (!template?.ready || !template.members?.length) return;
    setCreatingTemplate(template.kind);
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: template.comboName,
          models: template.members.map((member) => ({
            model: member.model,
            ...(member.autoTier ? { autoTier: member.autoTier } : {}),
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "创建组合失败");
        return;
      }
      const created = await res.json();

      const strategy = TEMPLATE_STRATEGY[template.kind];
      if (strategy) {
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategies: { ...comboStrategies, [created.id]: strategy },
          }),
        });
      }

      await fetchData();
      if (created?.id != null) {
        setActiveComboId(created.id);
        // "Edit first" opens the ordinary edit dialog on the new combo, so the
        // operator can change what the template proposed before it routes.
        if (editAfter) setEditingCombo(created);
      }
    } catch (error) {
      console.log("Error creating combo from template:", error);
    } finally {
      setCreatingTemplate(null);
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
        const created = await res.json().catch(() => null);
        await fetchData();
        // Focus the freshly created combo so the detail pane matches the action
        // that opened the form instead of staying on the previous selection.
        if (created?.id != null) setActiveComboId(created.id);
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

  const handleUpdateComboAccessTags = async (id, accessTags) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessTags }),
      });
      if (res.ok) {
        const updated = await res.json();
        setCombos((current) => current.map((combo) => combo.id === id ? updated : combo));
        return true;
      }
      const err = await res.json();
      alert(err.error || "更新权限标签失败");
    } catch (error) {
      console.log("Error updating combo access tags:", error);
      alert("更新权限标签失败");
    }
    return false;
  };

  const handleUpdateComboModels = async (id, models) => {
    const scheduleError = getComboScheduleValidationError(models);
    if (scheduleError) {
      alert(scheduleError);
      return false;
    }

    setSavingModels(true);
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      });
      const updated = await res.json().catch(() => null);
      if (res.ok && updated) {
        setCombos((current) => current.map((combo) => combo.id === id ? updated : combo));
        setEditingCombo((current) => current?.id === id ? updated : current);
        return true;
      }
      alert(updated?.error || "更新路由节点失败");
    } catch (error) {
      console.log("Error updating combo models:", error);
      alert("更新路由节点失败");
    } finally {
      setSavingModels(false);
    }
    return false;
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "删除组合",
      message: "确定删除这个模型组合吗？删除后无法恢复。",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            setCombos((current) => current.filter((combo) => combo.id !== id));
            setEditingCombo((current) => current?.id === id ? null : current);
          }
        } catch (error) {
          console.log("Error deleting combo:", error);
        }
      }
    });
  };

  // Persist routing decisions on each combo. This keeps the visible selection
  // and runtime behavior aligned without relying on a hidden global default.
  //
  // Keyed by the combo's id: a name is mutable, and a strategy left under the
  // old name was silently dropped when the combo was renamed.
  const handleSetComboStrategy = async (comboId, patch) => {
    try {
      const updated = { ...comboStrategies };
      const next = { fallbackStrategy: "fallback", ...(updated[comboId] || {}), ...patch };

      if (patch.fallbackStrategy && patch.fallbackStrategy !== "round-robin") {
        delete next.stickyRoundRobinLimit;
      }
      if (patch.fallbackStrategy && patch.fallbackStrategy !== "fusion") {
        delete next.judgeModel;
      }
      if (patch.fallbackStrategy && patch.fallbackStrategy !== "auto") {
        delete next.autoRouting;
      }
      // The pin only means something while the combo routes manually; leaving it
      // behind on another strategy would silently resurrect an old pick if the
      // operator switched back.
      if (patch.fallbackStrategy && patch.fallbackStrategy !== "manual") {
        delete next.pick;
      }

      updated[comboId] = next;

      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategies: updated }),
      });
      if (!response.ok) {
        throw new Error(`Failed to update combo strategy: ${response.status}`);
      }

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
        >
          <Badge variant="default" size="md" icon="progress_activity">正在加载组合</Badge>
        </DashboardHero>
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6">
          <ModuleSkeleton title="正在加载模型组合" icon="layers" lines={5} className="min-h-[240px]" />
          <ModuleSkeleton title="正在读取调度策略" icon="account_tree" lines={6} className="min-h-[320px]" />
        </div>
      </div>
    );
  }

  const routedModelCount = combos.reduce((total, combo) => total + combo.models.length, 0);
  const fusionCount = combos.filter((combo) => (comboStrategies[combo.id]?.fallbackStrategy || "fallback") === "fusion").length;
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
  // Derived selection: an unknown/removed id falls back to the first combo, so no
  // effect has to keep the id and the list in sync.
  const activeCombo = combos.find((combo) => combo.id === activeComboId) || combos[0] || null;

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <DashboardHero
        eyebrow="Model routing"
        title="路由策略"
        description="将多个模型编排为稳定调用入口，并为每个组合指定清晰的调度方式。"
        icon="route"
      >
        <Badge variant="primary" size="md" icon="layers">{combos.length} 个模型组合</Badge>
        <Badge variant="default" size="md" icon="memory">{routedModelCount} 个路由节点</Badge>
        <Badge variant={fusionCount > 0 ? "info" : "default"} size="md" icon="account_tree">{fusionCount} 个融合策略</Badge>
      </DashboardHero>

      {/* Templates: a working group for a common need, built from the models this
          install can actually reach, in one click. Shown above the list so a new
          install has somewhere to start, and kept afterwards for anyone who does
          not want to reason about routing first. */}
      {templates.length > 0 && (
        <section aria-label="从模板开始" className="rounded-xl border border-border-subtle bg-surface/35 p-4">
          <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
            <span className="material-symbols-outlined text-[17px] text-[#7dd3fc]">auto_awesome</span>
            <h2 className="text-xs font-semibold text-text-main">从模板开始</h2>
            <span className="text-[11px] text-text-muted">用你自己已连接的模型组成，一键添加</span>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => {
              const needText = template.ready
                ? ""
                : (TEMPLATE_NEED_TEXT[template.need] || TEMPLATE_NEED_TEXT.any)(template.of);
              return (
                <div
                  key={template.kind}
                  className={`flex min-w-0 flex-col gap-1.5 rounded-lg border p-3 ${template.ready ? "border-white/[0.08] bg-black/[0.12]" : "border-white/[0.05] bg-black/[0.06] opacity-70"}`}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[11px] font-semibold text-text-main">{template.name}</span>
                    {template.kind === "steady" && (
                      <span className="shrink-0 rounded border border-emerald-400/20 bg-emerald-400/[0.07] px-1 py-0 text-[9px] text-emerald-200">跨供应商</span>
                    )}
                  </div>
                  <p className="text-[10px] leading-4 text-text-muted">{template.summary}</p>
                  <p className="truncate font-mono text-[10px] text-[#c5d4e2]" title={template.members.map((m) => m.model).join(" → ")}>
                    {template.ready
                      ? template.members.map((m) => getTemplateMemberLabel(m.model)).join(" → ")
                      : needText}
                  </p>
                  <div className="mt-auto flex items-center gap-2 pt-1.5">
                    <Button
                      size="sm"
                      icon="add"
                      disabled={!template.ready || creatingTemplate !== null}
                      onClick={() => handleCreateFromTemplate(template)}
                    >
                      {creatingTemplate === template.kind ? "添加中..." : "添加"}
                    </Button>
                    {template.ready && (
                      <button
                        type="button"
                        onClick={() => handleCreateFromTemplate(template, { editAfter: true })}
                        disabled={creatingTemplate !== null}
                        className="text-[10px] font-medium text-text-muted transition-colors hover:text-[#7dd3fc] disabled:opacity-40"
                        title="创建后立即打开编辑，可在开始路由前调整"
                      >
                        先编辑
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Routing mirrors the channel list: a combo rail on the left, the selected
          combo's full configuration on the right. */}
      {combos.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg/20 px-6 text-center">
          <span className="material-symbols-outlined mb-3 text-[34px] text-[#647688]">layers</span>
          <h2 className="text-base font-semibold text-text-main">还没有模型组合</h2>
          <p className="mt-1 max-w-sm text-sm text-text-muted">新建一个组合后，即可为同一模型入口配置回退、轮询或融合策略。</p>
          <Button icon="add" className="mt-5" onClick={() => setShowCreateModal(true)}>新增模型组合</Button>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6">
          <ComboGroupRail
            groups={comboGroups}
            strategies={comboStrategies}
            activeId={activeCombo?.id ?? null}
            totalCombos={combos.length}
            totalNodes={routedModelCount}
            onSelect={setActiveComboId}
            onAdd={() => setShowCreateModal(true)}
          />
          {activeCombo && (
            <section aria-label={`${activeCombo.name} 组合详情`} className="flex min-w-0 flex-col gap-4">
              <div className="flex items-start gap-3 rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/[0.045] px-4 py-3">
                <span className="material-symbols-outlined mt-0.5 text-[19px] text-[#7dd3fc]">route</span>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-text-main">组合如何调度</h2>
                  <p className="mt-1 text-xs leading-5 text-text-muted"><span className="font-medium text-text-main">回退</span> 按顺序切换；<span className="font-medium text-text-main">轮询</span> 均匀分摊负载；<span className="font-medium text-text-main">按权重</span> 按节点权重分配，比例精确；<span className="font-medium text-text-main">手动</span> 只发往指定节点，不做故障转移；<span className="font-medium text-text-main">融合</span> 并行调用并交由裁判模型汇总，质量更高但会产生 N+1 次调用。</p>
                </div>
              </div>

              <ComboCard
                key={activeCombo.id}
                combo={activeCombo}
                getCaps={getCaps}
                activeProviders={activeProviders}
                onEdit={() => setEditingCombo(activeCombo)}
                onToggleActive={(isActive) => handleToggleComboActive(activeCombo.id, isActive)}
                onUpdateAccessTags={(accessTags) => handleUpdateComboAccessTags(activeCombo.id, accessTags)}
                onUpdateModels={(models) => handleUpdateComboModels(activeCombo.id, models)}
                strategy={comboStrategies[activeCombo.id] || {}}
                onSetStrategy={(patch) => handleSetComboStrategy(activeCombo.id, patch)}
                modelAliases={modelAliases}
                savingModels={savingModels}
              />
            </section>
          )}
        </div>
      )}

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
          combos={combos}
        />
      )}

      {editingCombo && (
        <ComboFormModal
          key={editingCombo.id}
          isOpen={!!editingCombo}
          combo={editingCombo}
          onClose={() => setEditingCombo(null)}
          onSave={(data) => handleUpdate(editingCombo.id, data)}
          onDelete={() => handleDelete(editingCombo.id)}
          activeProviders={activeProviders}
          getCaps={getCaps}
          groupOptions={groupOptions}
          combos={combos}
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
  { value: "fallback", label: "回退", description: "按模型顺序尝试，失败后切换到下一个", icon: "arrow_right_alt" },
  { value: "round-robin", label: "轮询", description: "在模型之间轮换请求以分摊负载", icon: "sync" },
  { value: "weighted", label: "按权重", description: "按每个节点的权重分配请求，比例精确", icon: "balance" },
  { value: "manual", label: "手动", description: "全部请求发往指定节点，失败也不切换", icon: "push_pin" },
  { value: "fusion", label: "融合", description: "并行调用面板模型，并由裁判模型综合结果", icon: "merge_type" },
  { value: "auto", label: "自动", description: "先判断任务复杂度，再按模型层级选择", icon: "auto_awesome" },
];

const STRATEGY_LABELS = Object.fromEntries(STRATEGY_OPTIONS.map((option) => [option.value, option.label]));

// The strategy a freshly created template combo starts with. A template decides
// WHICH models to put together; this decides how they take turns.
//   smart/thrifty -> auto: the tiers the template assigned only matter under
//                    automatic selection (otherwise it is just an ordered list).
//   steady        -> fallback: "each one behind the other" is exactly in-order.
const TEMPLATE_STRATEGY = {
  smart: { fallbackStrategy: "auto" },
  thrifty: { fallbackStrategy: "auto" },
  steady: { fallbackStrategy: "fallback" },
};

// A template member as the operator recognises it: the model id without its
// provider prefix, since the provider is often the same across a template.
function getTemplateMemberLabel(modelId) {
  const slash = String(modelId || "").lastIndexOf("/");
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

// Why a template cannot be built, in the operator's words.
const TEMPLATE_NEED_TEXT = {
  providers: (of) => `需要两个以上供应商的模型，当前只有 ${of || "一个"}`,
  cheap: (of) => `需要比 ${of || "当前最强模型"} 更便宜的模型`,
  any: () => "还没有可用的供应商，请先添加连接",
};

// What the node list means under each strategy, shown above it.
const NODE_LIST_CAPTIONS = {
  fallback: "按以下顺序依次尝试",
  "round-robin": "请求在以下节点间轮换",
  weighted: "按每个节点的权重分配请求",
  manual: "只发往固定节点，其余节点不参与",
  fusion: "以下节点将被并行调用",
};

// Left rail: mirrors the channel list's group rail — the page-level action lives in
// the rail header and only the list scrolls. Combo groups keep their configured
// names so the rail matches the grouping used by every combo form.
function ComboGroupRail({ groups, strategies = {}, activeId, totalCombos, totalNodes, onSelect, onAdd }) {
  return (
    <aside aria-label="模型组合" className="flex min-w-0 flex-col rounded-xl border border-border-subtle bg-surface/35 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.065] p-2.5">
        <p className="mr-auto font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#647688]">模型组合</p>
        <Tooltip text="新增模型组合">
          <button
            type="button"
            onClick={onAdd}
            aria-label="新增模型组合"
            className="flex size-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]"
          >
            <span className="material-symbols-outlined text-[16px]! leading-none">add</span>
          </button>
        </Tooltip>
      </div>
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5">
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 px-1.5">
                <span className="material-symbols-outlined text-[13px] text-[#7dd3fc]">folder</span>
                <span className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-[#647688]">{group.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-[#647688]">{group.combos.length}</span>
              </div>
              {group.combos.map((combo) => {
                const isActive = combo.id === activeId;
                const isEnabled = combo.isActive !== false;
                const strategyLabel = STRATEGY_LABELS[strategies[combo.id]?.fallbackStrategy || "fallback"] || "回退";
                return (
                  <button
                    key={combo.id}
                    type="button"
                    onClick={() => onSelect(combo.id)}
                    aria-current={isActive ? "true" : undefined}
                    className={`group flex min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${isActive ? "border-[#38bdf8]/35 bg-[#38bdf8]/[0.08] text-text-main" : "border-transparent text-text-muted hover:bg-white/[0.04] hover:text-text-main"}`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={`size-1.5 shrink-0 rounded-full ${isEnabled ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)]" : "bg-slate-500"}`} title={isEnabled ? "路由中" : "已停用"} />
                      <span className="truncate font-mono text-[12px] font-medium">{combo.name}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 pl-3 font-mono text-[10px] text-[#647688]">
                      <span className="shrink-0">{strategyLabel}</span>
                      <span className="shrink-0">·</span>
                      <span className="truncate">{combo.models.length} 节点</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-white/[0.065] px-3.5 py-2 text-[10px] text-[#647688]">
        共 <span className="font-mono tabular-nums text-text-muted">{totalCombos}</span> 个组合 · <span className="font-mono tabular-nums text-text-muted">{totalNodes}</span> 个路由节点
      </div>
    </aside>
  );
}

function ComboCard({ combo, getCaps, activeProviders = [], onEdit, onToggleActive, onUpdateAccessTags, onUpdateModels, strategy = {}, onSetStrategy, modelAliases = {}, savingModels = false }) {
  const [showClassifierSelect, setShowClassifierSelect] = useState(false);
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const [showPickSelect, setShowPickSelect] = useState(false);
  const [showModelSelect, setShowModelSelect] = useState(false);
  // Which tier section's "add" opened the drawer, so the picked models land
  // there. Null means the plain "添加模型" button (no tier).
  const [addingTier, setAddingTier] = useState(null);
  const [models, setModels] = useState(combo.models);
  const [scheduleError, setScheduleError] = useState(null);
  const [addingAccessTag, setAddingAccessTag] = useState(false);
  const [newAccessTag, setNewAccessTag] = useState("");
  const [savingAccessTags, setSavingAccessTags] = useState(false);
  const [rrDraft, setRrDraft] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const current = strategy.fallbackStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const pick = strategy.pick || "";
  // Default on: capability auto-switch predates this switch, and turning it off
  // by default would change how every existing combo routes images.
  const autoSwitch = strategy.autoSwitch !== false;
  const classifierModel = strategy.autoRouting?.classifierModel || "";

  const isFusion = current === "fusion";
  const isActive = combo.isActive !== false;
  const roundRobinLimit = strategy.stickyRoundRobinLimit || 1;
  // The draft only applies while round-robin is selected; switching strategies drops it.
  const activeRrDraft = current === "round-robin" ? rrDraft : null;
  const effectiveRoundRobinLimit = Number.parseInt(activeRrDraft ?? roundRobinLimit, 10) || 1;
  const exposedCapabilities = getComboCapabilities(combo.capabilities);
  const accessTags = Array.isArray(combo.accessTags) ? combo.accessTags : [];

  useEffect(() => {
    const syncTimer = setTimeout(() => setModels(combo.models), 0);
    return () => clearTimeout(syncTimer);
  }, [combo.id, combo.models]);

  // Release the local round-robin echo once the persisted strategy catches up.
  useEffect(() => {
    setRrDraft((draft) => (draft !== null && draft === String(roundRobinLimit) ? null : draft));
  }, [roundRobinLimit]);

  // Release the local round-robin echo once the persisted strategy catches up.
  useEffect(() => {
    setRrDraft((draft) => (draft !== null && draft === String(roundRobinLimit) ? null : draft));
  }, [roundRobinLimit]);

  // Commit the round-robin draft on blur/Enter instead of every keystroke, so
  // typing "10" doesn't fire two settings PATCHes and the field stays clearable.
  // A valid commit keeps echoing locally until the persisted strategy catches up.
  const commitRoundRobinLimit = () => {
    if (rrDraft === null) return;
    const next = Number.parseInt(rrDraft, 10);
    if (Number.isFinite(next) && next > 0 && next !== roundRobinLimit) {
      setRrDraft(String(next));
      onSetStrategy({ stickyRoundRobinLimit: next });
    } else {
      setRrDraft(null);
    }
  };

  const stepRoundRobinLimit = (delta) => {
    const draft = rrDraft === null ? null : Number.parseInt(rrDraft, 10);
    const base = Number.isFinite(draft) && draft > 0 ? draft : roundRobinLimit;
    const next = Math.max(1, base + delta);
    setRrDraft(String(next));
    if (next !== roundRobinLimit) onSetStrategy({ stickyRoundRobinLimit: next });
  };

  const updateClassifierModel = (model) => {
    onSetStrategy({
      autoRouting: {
        ...(strategy.autoRouting || {}),
        classifierModel: model,
      },
    });
  };

  const persistAccessTags = async (nextTags) => {
    setSavingAccessTags(true);
    const saved = await onUpdateAccessTags(nextTags);
    setSavingAccessTags(false);
    return saved;
  };

  const handleAddAccessTag = async () => {
    const nextTags = normalizeAccessTags([...accessTags, ...newAccessTag.split(/[,，\n]/)]);
    if (nextTags.length === accessTags.length) {
      setNewAccessTag("");
      setAddingAccessTag(false);
      return;
    }
    const saved = await persistAccessTags(nextTags);
    if (saved) {
      setNewAccessTag("");
      setAddingAccessTag(false);
    }
  };

  const handleRemoveAccessTag = async (tag) => {
    await persistAccessTags(accessTags.filter((item) => item !== tag));
  };

  const nodeRole = (index) => {
    if (current === "fusion") return "并行";
    if (current === "round-robin") return "轮询";
    if (current === "weighted") return `${comboModelEntryParts(models[index]).weight} 份`;
    if (current === "manual") {
      const model = getComboModelValue(models[index]);
      return model && model === pick ? "固定" : "不参与";
    }
    return index === 0 ? "首选" : `备选 ${index}`;
  };

  const modelItems = models.map((entry, index) => ({ uid: `node-${index}`, entry }));

  const persistModels = async (nextModels) => {
    setModels(nextModels);
    const error = getComboScheduleValidationError(nextModels);
    if (error) {
      setScheduleError(error);
      return;
    }

    setScheduleError(null);
    const saved = await onUpdateModels?.(nextModels);
    if (saved === false) setModels(combo.models);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = modelItems.findIndex((item) => item.uid === active.id);
    const newIndex = modelItems.findIndex((item) => item.uid === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      persistModels(arrayMove(models, oldIndex, newIndex));
    }
  };

  const updateModelAt = (index, nextEntry) => {
    persistModels(models.map((entry, i) => i === index ? nextEntry : entry));
  };

  const removeModelAt = (index) => {
    persistModels(models.filter((_, i) => i !== index));
  };

  const moveModel = (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= models.length) return;
    persistModels(arrayMove(models, index, nextIndex));
  };

  /**
   * Add a member, optionally into a tier section.
   *
   * Under automatic routing the tier is decided by WHERE the operator added the
   * model from, not by a control on the node: each section's button opens this
   * same drawer with its tier attached. Without it every node stored the
   * default tier and all of them landed in 均衡.
   */
  const addModel = (model, tier = null) => {
    const modelValue = model?.value || "";
    if (!modelValue || models.some((entry) => getComboModelValue(entry) === modelValue)) return;
    persistModels([...models, tier ? buildComboModelEntry(modelValue, null, [], tier) : modelValue]);
  };

  /**
   * Models the current strategy consults besides the ones it answers with.
   *
   * These used to be small selects buried inside the strategy list on the
   * right, which made them look like options OF the strategy rather than
   * participants IN routing. They are now sections above the member list, the
   * same shape as the tier sections, so the whole routing picture reads
   * top-to-bottom in one column.
   */
  const roleGroups = [];
  if (current === "auto") {
    roleGroups.push({
      key: "classifier",
      icon: "psychology",
      title: "分类模型",
      hint: "判断任务复杂度，不负责回答",
      value: classifierModel,
      placeholder: "选择分类模型",
      onPick: () => setShowClassifierSelect(true),
      onClear: classifierModel ? () => updateClassifierModel("") : null,
      tone: "amber",
    });
  }
  if (current === "manual") {
    roleGroups.push({
      key: "pick",
      icon: "push_pin",
      title: "固定发往",
      hint: "其余节点不参与，失败也不切换",
      value: pick,
      placeholder: "选择固定节点",
      onPick: () => setShowPickSelect(true),
      onClear: pick ? () => onSetStrategy({ pick: "" }) : null,
      tone: "sky",
    });
  }
  if (current === "fusion") {
    roleGroups.push({
      key: "judge",
      icon: "gavel",
      title: "裁判模型",
      hint: "汇总各节点结果，写出最终回答",
      value: judge,
      placeholder: "自动选择（取首个节点）",
      onPick: () => setShowJudgeSelect(true),
      onClear: judge ? () => onSetStrategy({ judgeModel: "" }) : null,
      tone: "violet",
    });
  }

  return (
    <section className={`overflow-hidden rounded-xl border bg-surface/40 transition-colors ${isActive ? "border-border-subtle" : "border-white/[0.055] opacity-75"}`}>
      <header className="flex flex-col gap-3 border-b border-white/[0.065] bg-white/[0.018] px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/10 text-[#7dd3fc]">
            <span className="material-symbols-outlined text-[20px]">layers</span>
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate font-mono text-[15px] font-semibold text-text-main">{combo.name}</h2>
              {combo.search && <span className="rounded-md border border-[#38bdf8]/20 px-1.5 py-0.5 text-[10px] text-[#7dd3fc]">联网搜索 · {getComboSearchProviders().find(({ id }) => id === combo.search.provider)?.name || combo.search.provider}</span>}
              <span className="rounded-md border border-white/[0.08] bg-black/[0.12] px-1.5 py-0.5 text-[10px] text-text-muted" title="数值越小越靠前">排序 {combo.sortOrder ?? 0}</span>
            </div>
          </div>
        </div>

        <div className="inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-lg border border-white/[0.08] bg-black/[0.12]">
          <div className="flex items-center gap-2 border-r border-white/[0.08] px-2.5" title={isActive ? "禁用组合" : "启用组合"}>
            <span className={`size-1.5 rounded-full ${isActive ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)]" : "bg-slate-500"}`} />
            <span className={`text-[11px] font-medium ${isActive ? "text-emerald-200" : "text-text-muted"}`}>{isActive ? "路由中" : "已停用"}</span>
            <Toggle checked={isActive} onChange={onToggleActive} size="sm" />
          </div>
          <button type="button" onClick={onEdit} className="flex w-8 items-center justify-center text-text-muted transition-colors hover:bg-[#38bdf8]/[0.07] hover:text-[#7dd3fc] focus-visible:z-10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#38bdf8]/60" title="组合设置" aria-label="组合设置">
            <span className="material-symbols-outlined text-[16px]">settings</span>
          </button>
        </div>
      </header>

      <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold text-text-main">路由节点</h3>
              <p className="mt-0.5 text-[11px] text-text-muted">{NODE_LIST_CAPTIONS[current] || "以下节点将被并行调用"}</p>
            </div>
            <span className="rounded-full border border-white/[0.08] bg-black/[0.12] px-2 py-0.5 font-mono text-[10px] text-text-muted">{combo.models.length} 个</span>
          </div>

          {/* The classifier is a node of this combo, not a setting of it: it is
              asked on every turn and its answer picks which member serves. It
              therefore sits at the head of the node list, in its own group, so
              it is visible before the members it chooses between — and so its
              different job (judging, not answering) is obvious. */}
          {/* Role groups: the models a strategy consults BESIDES the members it
              answers with. Each is a section at the head of the node list, in
              the same shape as the tier sections below, so "which model does
              what" is read from one place regardless of strategy. */}
          {roleGroups.map((group) => (
            <RoleGroup
              key={group.key}
              icon={group.icon}
              title={group.title}
              hint={group.hint}
              value={group.value}
              placeholder={group.placeholder}
              onPick={group.onPick}
              onClear={group.onClear}
              tone={group.tone}
            />
          ))}

          {models.length === 0 ? (
            <div className="flex min-h-20 items-center justify-center rounded-lg border border-dashed border-white/[0.09] bg-black/[0.06] text-xs italic text-text-muted">尚未添加模型</div>
          ) : current === "auto" ? (
            /* Under automatic routing a member's tier IS its routing, not a
               label on it: the classifier picks a level and every member in that
               level is tried. Grouping the list by tier says that with the
               layout, and removes the per-node tier control entirely — with the
               list grouped, the control would only restate the group it sits in. */
            <div className="flex min-w-0 flex-col gap-2">
              {AUTO_TIER_GROUPS.map((tier) => {
                const tierItems = modelItems
                  .map(({ uid, entry }, index) => ({ uid, entry, index }))
                  .filter(({ entry }) => getComboModelAutoTier(entry) === tier.value);
                return (
                  <div key={tier.value} className="min-w-0 overflow-hidden rounded-lg border border-white/[0.07] bg-black/[0.10]">
                    <div className="flex min-w-0 items-center gap-1.5 border-b border-white/[0.06] px-2.5 py-1.5">
                      <span className={`material-symbols-outlined shrink-0 text-[13px] ${tier.tone}`}>{tier.icon}</span>
                      <span className={`shrink-0 text-[10px] font-semibold ${tier.titleTone}`}>{tier.label}</span>
                      <span className="min-w-0 truncate text-[9px] text-text-muted">{tier.hint}</span>
                      <span className="ml-auto shrink-0 rounded-full border border-white/[0.08] bg-black/[0.12] px-1.5 font-mono text-[9px] text-text-muted">{tierItems.length}</span>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5 p-1.5">
                      {tierItems.length === 0 ? (
                        <button
                          type="button"
                          onClick={() => { setAddingTier(tier.value); setShowModelSelect(true); }}
                          disabled={savingModels}
                          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/[0.1] py-1.5 text-[10px] text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
                        >
                          <span className="material-symbols-outlined text-[13px]">add</span>
                          添加{tier.label}模型
                        </button>
                      ) : tierItems.map(({ uid, entry, index }) => (
                        <ModelItem
                          key={uid}
                          id={uid}
                          index={index}
                          entry={entry}
                          isFirst={index === 0}
                          isLast={index === modelItems.length - 1}
                          disabled={savingModels}
                          getCaps={getCaps}
                          role={tier.label}
                          showWeight={false}
                          onEdit={(newVal) => {
                            const updated = typeof entry === "object" && entry !== null
                              ? { ...entry, model: newVal }
                              : newVal;
                            updateModelAt(index, updated);
                          }}
                          onScheduleChange={(schedule) => updateModelAt(index, rebuildComboModelEntry(entry, { schedule }))}
                          onAccessTagsChange={(accessTags) => updateModelAt(index, rebuildComboModelEntry(entry, { accessTags }))}
                          onEffortChange={(effort) => updateModelAt(index, rebuildComboModelEntry(entry, { effort }))}
                          onMoveUp={() => moveModel(index, -1)}
                          onMoveDown={() => moveModel(index, 1)}
                          onRemove={() => removeModelAt(index)}
                        />
                      ))}
                      {tierItems.length > 0 && (
                        <button
                          type="button"
                          onClick={() => { setAddingTier(tier.value); setShowModelSelect(true); }}
                          disabled={savingModels}
                          className="flex w-full items-center justify-center gap-1 rounded-md py-1 text-[10px] text-text-muted transition-colors hover:bg-white/[0.04] hover:text-primary"
                        >
                          <span className="material-symbols-outlined text-[13px]">add</span>
                          添加到{tier.label}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={modelItems.map((item) => item.uid)} strategy={verticalListSortingStrategy}>
                <div className="flex min-w-0 flex-col gap-1.5">
                  {modelItems.map(({ uid, entry }, index) => (
                    <ModelItem
                      key={uid}
                      id={uid}
                      index={index}
                      entry={entry}
                      isFirst={index === 0}
                      isLast={index === modelItems.length - 1}
                      disabled={savingModels}
                      getCaps={getCaps}
                      role={nodeRole(index)}
                      showWeight={current === "weighted"}
                      onEdit={(newVal) => {
                        const updated = typeof entry === "object" && entry !== null
                          ? { ...entry, model: newVal }
                          : newVal;
                        updateModelAt(index, updated);
                      }}
                      onScheduleChange={(schedule) => {
                        updateModelAt(index, rebuildComboModelEntry(entry, { schedule }));
                      }}
                      onAccessTagsChange={(accessTags) => {
                        updateModelAt(index, rebuildComboModelEntry(entry, { accessTags }));
                      }}
                      onEffortChange={(effort) => {
                        updateModelAt(index, rebuildComboModelEntry(entry, { effort }));
                      }}
                      onWeightChange={(weight) => {
                        updateModelAt(index, rebuildComboModelEntry(entry, { weight }));
                      }}
                      onMoveUp={() => moveModel(index, -1)}
                      onMoveDown={() => moveModel(index, 1)}
                      onRemove={() => removeModelAt(index)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}

          <button
            type="button"
            onClick={() => setShowModelSelect(true)}
            disabled={savingModels}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-white/[0.1] py-2 text-xs font-medium text-primary transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-wait disabled:opacity-45"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            添加模型
          </button>
          {savingModels && <p className="mt-1 text-right text-[10px] text-text-muted">正在保存节点配置...</p>}
          {scheduleError && <p className="mt-1 text-[10px] font-medium text-red-400">{scheduleError}</p>}

          {/* Capability auto-switch floats a vision/pdf-capable member to the front
              for a request that needs one. It is a convenience, not the operator's
              intent: left on, a deliberately ordered first pick is silently
              overridden, and the only trace is a log line. So it is a visible
              per-combo choice rather than an implicit default. */}
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/[0.07] bg-black/[0.08] px-2.5 py-2">
            <span className="material-symbols-outlined mt-0.5 text-[15px] text-[#7dd3fc]">swap_vert</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-text-main">按请求能力临时调序</span>
                <Toggle
                  checked={autoSwitch}
                  onChange={(value) => onSetStrategy({ autoSwitch: value })}
                  size="sm"
                />
              </div>
              <p className="mt-0.5 text-[9px] leading-3 text-text-muted">
                {autoSwitch
                  ? "带图片或 PDF 的请求会临时把支持的节点提到最前；关闭后严格按上方顺序。"
                  : "严格按上方顺序尝试，即使请求带图片或 PDF。"}
              </p>
            </div>
          </div>
        </div>

        <aside className="border-t border-white/[0.065] bg-black/[0.045] px-3 py-3 lg:border-l lg:border-t-0">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[15px] text-[#7dd3fc]">tune</span>
            <h3 className="text-[11px] font-semibold text-text-main">调度策略</h3>
          </div>

          <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label={`${combo.name} 调度策略`}>
            {STRATEGY_OPTIONS.map((option) => {
              const selected = current === option.value;
              return (
                <div key={option.value} className={`overflow-hidden rounded-md border transition-colors ${selected ? "border-[#38bdf8]/30 bg-[#38bdf8]/[0.07]" : "border-white/[0.07] bg-black/[0.08]"}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onSetStrategy({ fallbackStrategy: option.value })}
                    className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors ${selected ? "text-[#7dd3fc]" : "text-text-muted hover:bg-white/[0.035] hover:text-text-main"}`}
                  >
                    <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${selected ? "bg-[#38bdf8]/12" : "bg-white/[0.04]"}`}>
                      <span className="material-symbols-outlined text-[14px]">{option.icon}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[10px] font-medium ${selected ? "text-[#bae6fd]" : "text-text-main"}`}>{option.label}</span>
                      <span className="mt-0.5 block text-[8px] leading-3 text-text-muted">{option.description}</span>
                    </span>
                    <span className={`size-1 shrink-0 rounded-full ${selected ? "bg-[#38bdf8]" : "bg-transparent"}`} />
                  </button>

                  {selected && option.value === "round-robin" && (
                    <div className="flex items-center justify-between gap-3 border-t border-[#38bdf8]/15 px-2 py-1.5 text-[9px] text-text-muted" title="每个节点连续处理多少次请求后，再轮换到下一个节点">
                      <span className="shrink-0">每个节点连续请求</span>
                      <span className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => stepRoundRobinLimit(-1)}
                          disabled={effectiveRoundRobinLimit <= 1}
                          className="flex size-6 items-center justify-center rounded-md border border-[#38bdf8]/25 bg-black/[0.12] text-[#7dd3fc] transition-colors hover:border-[#38bdf8]/50 hover:bg-[#38bdf8]/10 disabled:cursor-not-allowed disabled:opacity-35"
                          title="减少 1 次"
                          aria-label={`${combo.name} 减少连续请求数`}
                        >
                          <span className="material-symbols-outlined text-[13px]">remove</span>
                        </button>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={rrDraft ?? String(roundRobinLimit)}
                          onChange={(event) => setRrDraft(event.target.value)}
                          onFocus={(event) => event.target.select()}
                          onBlur={commitRoundRobinLimit}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setRrDraft(null);
                          }}
                          className="h-6 w-10 rounded-md border border-[#38bdf8]/25 bg-black/[0.12] text-center font-mono text-[11px] text-[#bae6fd] outline-none focus:border-[#38bdf8]/50"
                          aria-label={`${combo.name} 每个模型的轮询次数`}
                        />
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => stepRoundRobinLimit(1)}
                          className="flex size-6 items-center justify-center rounded-md border border-[#38bdf8]/25 bg-black/[0.12] text-[#7dd3fc] transition-colors hover:border-[#38bdf8]/50 hover:bg-[#38bdf8]/10"
                          title="增加 1 次"
                          aria-label={`${combo.name} 增加连续请求数`}
                        >
                          <span className="material-symbols-outlined text-[13px]">add</span>
                        </button>
                        <span>次</span>
                      </span>
                    </div>
                  )}

                </div>
              );
            })}
          </div>
        </aside>
      </div>

      <footer className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/[0.065] bg-white/[0.012] px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="material-symbols-outlined text-[15px] text-[#7dd3fc]">deployed_code</span>
          <span className="shrink-0 text-[10px] font-medium text-text-muted">对外能力</span>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            {exposedCapabilities.contextWindow && <span className="rounded border border-white/[0.08] bg-black/[0.12] px-1.5 py-0.5 font-mono text-[#c5d4e2]">{formatContextWindowK(exposedCapabilities.contextWindow)} ctx</span>}
            {exposedCapabilities.vision && <span className="inline-flex items-center gap-0.5 rounded border border-[#38bdf8]/20 bg-[#38bdf8]/[0.06] px-1.5 py-0.5 text-[#7dd3fc]"><span className="material-symbols-outlined text-[12px]">visibility</span>视觉</span>}
            {exposedCapabilities.audioInput && <span className="inline-flex items-center gap-0.5 rounded border border-violet-400/20 bg-violet-400/[0.06] px-1.5 py-0.5 text-violet-200"><span className="material-symbols-outlined text-[12px]">graphic_eq</span>音频</span>}
            {!exposedCapabilities.contextWindow && !exposedCapabilities.vision && !exposedCapabilities.audioInput && <span className="text-[11px] text-text-muted">未声明</span>}
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:ml-auto" title={accessTags.length ? `拥有任一标签即可访问：${accessTags.join("、")}` : "未设置权限标签，所有 API 密钥均可访问"}>
          <span className="hidden h-4 w-px bg-white/[0.08] sm:mr-1 sm:block" />
          <span className="material-symbols-outlined text-[15px] text-violet-300">shield_lock</span>
          <span className="shrink-0 text-[10px] font-medium text-text-muted">访问范围</span>
          {savingAccessTags && <span className="text-[10px] text-text-muted">保存中...</span>}

          {accessTags.length ? accessTags.map((tag) => (
            <span key={tag} className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-400/20 bg-violet-400/[0.08] pl-2 pr-1 font-mono text-[10px] text-violet-200">
              {tag}
              <button type="button" onClick={() => handleRemoveAccessTag(tag)} disabled={savingAccessTags} className="flex size-5 items-center justify-center rounded text-violet-300/60 transition-colors hover:bg-violet-400/10 hover:text-violet-100 disabled:cursor-wait disabled:opacity-40" title={`移除标签 ${tag}`} aria-label={`移除标签 ${tag}`}>
                <span className="material-symbols-outlined text-[12px]">close</span>
              </button>
            </span>
          )) : (
            <span className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-400/15 bg-emerald-400/[0.06] px-2 text-[10px] text-emerald-200"><span className="material-symbols-outlined text-[13px]">public</span>公开访问</span>
          )}

          {addingAccessTag ? (
            <span className="inline-flex h-7 items-center overflow-hidden rounded-md border border-violet-400/25 bg-black/[0.12] focus-within:border-violet-400/50">
              <input
                autoFocus
                value={newAccessTag}
                onChange={(event) => setNewAccessTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleAddAccessTag();
                  }
                  if (event.key === "Escape") {
                    setNewAccessTag("");
                    setAddingAccessTag(false);
                  }
                }}
                placeholder="输入标签"
                className="h-full w-24 bg-transparent px-2 text-[11px] text-text-main outline-none placeholder:text-text-muted"
                aria-label="新增权限标签"
              />
              <button type="button" onClick={handleAddAccessTag} disabled={!newAccessTag.trim() || savingAccessTags} className="flex size-7 items-center justify-center border-l border-white/[0.08] text-violet-200 transition-colors hover:bg-violet-400/10 disabled:opacity-35" title="添加标签" aria-label="添加标签"><span className="material-symbols-outlined text-[14px]">check</span></button>
              <button type="button" onClick={() => { setNewAccessTag(""); setAddingAccessTag(false); }} disabled={savingAccessTags} className="flex size-7 items-center justify-center border-l border-white/[0.08] text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text-main disabled:opacity-35" title="取消添加" aria-label="取消添加"><span className="material-symbols-outlined text-[14px]">close</span></button>
            </span>
          ) : (
            <button type="button" onClick={() => setAddingAccessTag(true)} disabled={savingAccessTags} className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-white/[0.1] px-2 text-[10px] text-text-muted transition-colors hover:border-violet-400/30 hover:bg-violet-400/[0.045] hover:text-violet-200 disabled:cursor-wait disabled:opacity-40" title="添加权限标签">
              <span className="material-symbols-outlined text-[13px]">add</span>
              添加标签
            </button>
          )}
        </div>
      </footer>

      {showClassifierSelect && (
        <ModelSelectModal
          isOpen={showClassifierSelect}
          onClose={() => setShowClassifierSelect(false)}
          onSelect={(model) => {
            updateClassifierModel(model?.value || "");
            setShowClassifierSelect(false);
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="选择分类模型"
          addedModelValues={classifierModel ? [classifierModel] : []}
          availableModelsOnly
          closeOnSelect
          presentation="drawer"
          drawerWidth="xl"
        />
      )}

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => { setShowModelSelect(false); setAddingTier(null); }}
          onSelect={(model) => addModel(model, addingTier)}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={addingTier ? `添加${AUTO_TIER_GROUP_LABELS[addingTier] || ""}模型` : "添加路由节点"}
          addedModelValues={models.map(getComboModelValue)}
          availableModelsOnly
          closeOnSelect={false}
          presentation="drawer"
          drawerWidth="xl"
        />
      )}

      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(model) => {
            onSetStrategy({ judgeModel: model?.value || "" });
            setShowJudgeSelect(false);
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="选择裁判模型"
          addedModelValues={judge ? [judge] : []}
          availableModelsOnly
          closeOnSelect
          presentation="drawer"
          drawerWidth="xl"
        />
      )}

      {showPickSelect && (
        <ModelSelectModal
          isOpen={showPickSelect}
          onClose={() => setShowPickSelect(false)}
          onSelect={(model) => {
            onSetStrategy({ pick: model?.value || "" });
            setShowPickSelect(false);
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="选择固定节点"
          addedModelValues={pick ? [pick] : []}
          availableModelsOnly
          closeOnSelect
          presentation="drawer"
          drawerWidth="xl"
        />
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
  // A time input renders a native clock affordance, so it needs real width.
  // Fixed-width + shrink-0 in a narrow column pushed the remove button onto a
  // second line and left the "+" stranded under a gap; these sizes are chosen to
  // fit one window row (two inputs + remove) inside the panel's inner width.
  const timeInputClass = (window) => [
    "h-7 w-[5.25rem] rounded-md border bg-white px-1.5 font-mono text-[10px] tabular-nums text-text-main outline-none transition-colors focus:border-primary dark:bg-black/25",
    isTimeWindowInvalid(window) ? "border-red-400/60" : "border-white/[0.10] dark:border-white/[0.10]",
  ].join(" ");

  return (
    <section className="flex min-w-0 flex-col">
      {/* Header row: disclosure + label + count on the left, switch on the
          right. One line, so the two schedule sections no longer each waste a
          tall gap above their content. */}
      <div className="flex min-w-0 items-center gap-1.5 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className={`material-symbols-outlined shrink-0 text-[14px] text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}>
            chevron_right
          </span>
          {/* Level 2: coloured, and no deeper than the group containing it. */}
          <span className={`text-[10px] font-medium ${tone}`}>{label}</span>
          <span className="shrink-0 rounded bg-white/[0.06] px-1.5 text-[9px] tabular-nums leading-4 text-text-muted">
            {windows.length}
          </span>
          {!enabled && <span className="shrink-0 text-[9px] text-text-muted/70">已停用</span>}
        </button>
        <Toggle checked={enabled} onChange={(next) => onSetEnabled(next)} size="sm" />
      </div>

      {expanded && enabled && (
        <div className="flex min-w-0 flex-col gap-1 pl-5 pb-1">
          {windows.length === 0 && (
            <span className="text-[10px] text-text-muted">
              {field === "active" ? "未配置，表示全天可用" : "未配置失效时段"}
            </span>
          )}

          {windows.map((window, index) => (
            <div key={`${field}-${index}`} className="flex min-w-0 items-center gap-1.5">
              <input
                type="time"
                value={window.start || ""}
                onChange={(e) => onPatch(index, { start: e.target.value })}
                className={timeInputClass(window)}
                aria-label={`${model} ${label}开始时间`}
              />
              <span className="shrink-0 text-[10px] text-text-muted">–</span>
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
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
                title={`移除${label}`}
                aria-label={`移除${label}`}
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          ))}

          {/* Inline with the rows above it, at the same left edge as a time
              input: an add action that reads as part of the list, not a banner
              under it. */}
          <button
            type="button"
            onClick={onAdd}
            className="mt-0.5 inline-flex w-fit shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:bg-white/[0.04] hover:text-primary"
            title={`添加${label}`}
            aria-label={`添加${label}`}
          >
            <span className="material-symbols-outlined text-[13px]">add</span>
            添加时段
          </button>
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

function ModelItem({ id, index, entry, isFirst, isLast, disabled = false, getCaps, role, showWeight = false, onEdit, onScheduleChange, onAccessTagsChange, onEffortChange, onWeightChange, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const model = getComboModelValue(entry);
  const schedule = getComboModelSchedule(entry);
  const accessTags = getComboModelAccessTags(entry);
  const autoTier = getComboModelAutoTier(entry);
  const effort = typeof entry === "object" && entry !== null ? (entry.effort || null) : null;
  const weight = typeof entry === "object" && entry !== null && Number.isInteger(entry.weight) ? entry.weight : 1;
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

  const [expanded, setExpanded] = useState(!!schedule || accessTags.length > 0);
  const [expandedSections, setExpandedSections] = useState({ active: true, inactive: false });

  // Which advanced fields this node actually HAS, under the current strategy.
  //
  // The panel used to render every setting at once, so under "weighted" the
  // weight input sat below access tags, the effort select and a full schedule
  // editor — the one field that mattered was the hardest to find.
  // Only genuinely per-node fields. The auto tier is absent on purpose: the
  // list is grouped BY tier, so a control here would just restate its section.
  const strategyFields = [
    showWeight ? { key: "weight", summary: `权重 ${weight}` } : null,
  ].filter(Boolean);

  // Collapsed-state summary for the availability group: what is configured,
  // without opening it. Kept short — it sits on one line beside the title.
  const availabilitySummary = [
    accessTags.length > 0 ? `${accessTags.length} 个权限标签` : null,
    schedule ? (formatModelScheduleSummary(schedule) || "已配置时段") : null,
  ].filter(Boolean).join(" · ");

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
          {...(disabled ? {} : { ...attributes, ...listeners })}
          disabled={disabled}
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
            className="min-w-[5rem] flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-sm font-semibold text-text-main hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => setEditing(true)}
            title="Click to edit"
          >
            {model}
          </div>
        )}

        <CapacityBadges caps={getCaps?.(model)} />

        {role && (
          <span className="min-w-0 shrink truncate rounded-md bg-white/[0.045] px-2 py-1 text-[10px] font-medium text-text-muted">
            {role}
          </span>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            disabled={disabled || isFirst}
            onClick={onMoveUp}
            className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
            title="Move up"
          >
            <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
          </button>
          <button
            disabled={disabled || isLast}
            onClick={onMoveDown}
            className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
            title="Move down"
          >
            <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
          </button>
          <button
            disabled={disabled}
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
          onClick={() => setExpanded((value) => !value)}
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
        {accessTags.length > 0 && (
          <span className="shrink-0 rounded-full border border-violet-400/20 bg-violet-400/[0.08] px-1.5 py-0 text-[9px] font-medium text-violet-200">
            {accessTags.length} 个权限标签
          </span>
        )}
      </div>

      {/* One frame for the whole panel; the groups inside separate themselves
          with indentation and a hairline, not with a box each. */}
      {expanded && (
        <div className="ml-8 flex min-w-0 flex-col gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.015] p-2.5">
          {/* Effort always applies, so its group is always expanded. It is still
              a GROUP, not a loose field: it was floating directly in the panel
              while "可用性与权限" below it was a titled group, which made two
              siblings look like different kinds of thing. */}
          <div className="min-w-0">
            <div className="flex w-full min-w-0 items-center gap-1.5 px-1 py-1.5">
              <span className="material-symbols-outlined shrink-0 text-[14px] text-[#7dd3fc]">psychology</span>
              <span className="shrink-0 text-[11px] font-semibold tracking-wide text-text-main">思考档位</span>
              <span className="min-w-0 flex-1 truncate text-[9px] text-text-muted">
                {effort ? "每次下发都用这一档" : "跟随请求方"}
              </span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1 pl-6 pr-1" role="radiogroup" aria-label={`${model} 思考档位`}>
            {EFFORT_OPTIONS.map((option) => {
              const active = (effort || "") === option.value;
              return (
                <button
                  key={option.value || "inherit"}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onEffortChange?.(option.value || null)}
                  className={`h-6 shrink-0 rounded-md border px-1.5 text-[10px] transition-colors ${active
                    ? "border-[#38bdf8]/45 bg-[#38bdf8]/[0.12] font-medium text-[#bae6fd]"
                    : "border-white/[0.08] bg-black/[0.12] text-text-muted hover:border-white/20 hover:text-text-main"}`}
                >
                  {option.label}
                </button>
              );
            })}
            </div>
          </div>

          {/* Strategy-specific settings next: under the current strategy these
              are the ones that actually change how this node behaves. Anything
              that does not apply is not rendered at all, so the panel stays as
              short as the strategy allows. */}
          {strategyFields.length > 0 && (
            <AdvancedSection
              icon="tune"
              tone="text-[#7dd3fc]"
              title="调度相关"
              summary={strategyFields.map((field) => field.summary).filter(Boolean).join(" · ")}
              defaultOpen
            >
              <StrategyFields
                model={model}
                weight={weight}
                showWeight={showWeight}
                onWeightChange={onWeightChange}
              />
            </AdvancedSection>
          )}

          {/* Availability and access: when this node may be used and by whom.
              Folded away because it is set once and then rarely touched. */}
          <AdvancedSection
            icon="event_available"
            tone="text-[#94a3b8]"
            title="可用性与权限"
            summary={availabilitySummary || "全天可用 · 所有密钥"}
            defaultOpen={false}
          >
            <div>
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
                  {/* Explanation on its own line, the destructive action below
                      it. Side by side, the sentence wrapped and shoved the
                      link into the middle of the text. */}
                  <p className="text-[10px] leading-4 text-text-muted/80">
                    生效时段为空表示全天可用；命中任意失效时段时不参与路由。支持跨午夜，例如 22:00-06:00。
                  </p>
                  <button
                    type="button"
                    onClick={() => onScheduleChange(null)}
                    className="w-fit text-[10px] text-text-muted underline underline-offset-2 transition-colors hover:text-red-400"
                  >
                    清除时段配置
                  </button>
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
            {/* Access tags last: they are a permission boundary set once per
                node, not part of choosing how it routes, so they belong after
                the availability settings rather than at the top of the panel. */}
            <div className="border-t border-white/[0.05] pt-2.5">
              {/* The editor's own label is 12px — larger than this section's own
                  header — so it is blanked and a heading at the same level as
                  生效时段 is rendered above it instead. */}
              <div className="mb-1 flex min-w-0 items-center gap-1">
                <span className="material-symbols-outlined shrink-0 text-[13px] text-violet-300">shield_lock</span>
                <span className="text-[10px] font-medium text-violet-200">权限标签</span>
              </div>
              <AccessTagsEditor
                value={accessTags}
                onChange={onAccessTagsChange}
                compact
                label=""
                hint="未设置表示所有用户可用；设置后，需拥有任一相同标签，并且仍受组合权限标签限制。"
              />
            </div>
          </AdvancedSection>
        </div>
      )}
    </div>
  );
}

/**
 * A section for one of the models a strategy consults besides its members: the
 * classifier under "auto", the pinned member under "manual", the judge under
 * "fusion".
 *
 * Same shape as the tier sections below it — a titled card with the chosen
 * model inside — so all three strategies present their routing the same way.
 * The pick opens the normal model drawer, because choosing a model is the same
 * job everywhere in this page.
 */
function RoleGroup({ icon, title, hint, value, placeholder, onPick, onClear, tone = "sky" }) {
  const tones = {
    amber: { card: "border-amber-400/20 bg-amber-400/[0.035]", head: "border-amber-400/15", icon: "text-amber-300", title: "text-amber-100", hint: "text-amber-200/60", btn: "border-amber-400/25 text-amber-100 hover:border-amber-400/45 hover:bg-amber-400/[0.07]", clear: "text-amber-200/60 hover:text-red-300 hover:bg-red-500/10" },
    sky: { card: "border-[#38bdf8]/20 bg-[#38bdf8]/[0.035]", head: "border-[#38bdf8]/15", icon: "text-[#7dd3fc]", title: "text-[#bae6fd]", hint: "text-[#7dd3fc]/60", btn: "border-[#38bdf8]/25 text-[#bae6fd] hover:border-[#38bdf8]/45 hover:bg-[#38bdf8]/[0.07]", clear: "text-[#7dd3fc]/60 hover:text-red-300 hover:bg-red-500/10" },
    violet: { card: "border-violet-400/20 bg-violet-400/[0.035]", head: "border-violet-400/15", icon: "text-violet-300", title: "text-violet-100", hint: "text-violet-200/60", btn: "border-violet-400/25 text-violet-100 hover:border-violet-400/45 hover:bg-violet-400/[0.07]", clear: "text-violet-200/60 hover:text-red-300 hover:bg-red-500/10" },
  }[tone] || {};

  return (
    <div className={`mb-2 min-w-0 overflow-hidden rounded-lg border ${tones.card}`}>
      <div className={`flex min-w-0 items-center gap-1.5 border-b px-2.5 py-1.5 ${tones.head}`}>
        <span className={`material-symbols-outlined shrink-0 text-[13px] ${tones.icon}`}>{icon}</span>
        <span className={`shrink-0 text-[10px] font-semibold ${tones.title}`}>{title}</span>
        <span className={`min-w-0 truncate text-[9px] ${tones.hint}`}>{hint}</span>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className={`ml-auto flex size-5 shrink-0 items-center justify-center rounded transition-colors ${tones.clear}`}
            title={`清除${title}`}
            aria-label={`清除${title}`}
          >
            <span className="material-symbols-outlined text-[12px]">close</span>
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={onPick}
          className={`flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-black/[0.12] px-2.5 text-left text-[12px] transition-colors ${tones.btn}`}
        >
          <span className="truncate font-mono">{value || placeholder}</span>
          <span className="material-symbols-outlined ml-auto shrink-0 text-[16px] opacity-50">chevron_right</span>
        </button>
      </div>
    </div>
  );
}

/**
 * One collapsible group inside a node's advanced panel.
 *
 * The panel used to render every setting at once — access tags, effort, weight,
 * auto tier and the whole schedule editor — regardless of the combo's strategy,
 * so the strategy-specific field an operator actually came for was buried among
 * fields that did nothing under it.
 */
function AdvancedSection({ icon, tone, title, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="min-w-0">
      {/* Level 1 of the panel's hierarchy: larger and bolder than everything it
          contains, with the whole row as its hit target. Field labels inside are
          10px/regular; sub-groups are 10px/medium. Before this, header and field
          label were both 10px/400 and only 100 weight apart, so the panel had no
          readable levels and read as one flat list. */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
      >
        <span className={`material-symbols-outlined shrink-0 text-[14px] text-text-muted transition-transform ${open ? "rotate-90" : ""}`}>chevron_right</span>
        <span className={`material-symbols-outlined shrink-0 text-[14px] ${tone}`}>{icon}</span>
        <span className="shrink-0 text-[11px] font-semibold tracking-wide text-text-main">{title}</span>
        {summary && <span className="min-w-0 flex-1 truncate text-[9px] text-text-muted">{summary}</span>}
      </button>
      {open && <div className="flex min-w-0 flex-col gap-2.5 pb-1.5 pl-6 pt-1">{children}</div>}
    </div>
  );
}

/**
 * The strategy-specific fields a node offers right now.
 *
 * Rendered only when the strategy uses them: a weight input under "fallback"
 * would set a value nothing reads, and an auto tier outside "auto" is dead
 * configuration. Absent, not disabled — a greyed-out control still costs a row
 * and still reads as "something I should configure".
 */
function StrategyFields({ model, weight, showWeight, onWeightChange }) {
  return (
    <>
      {showWeight && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="material-symbols-outlined shrink-0 text-[13px] text-[#34d399]">balance</span>
          <span className="shrink-0 text-[10px] text-text-muted">权重</span>
          <input
            type="number"
            min={1}
            max={1000}
            step={1}
            value={weight}
            onChange={(event) => onWeightChange?.(Number.parseInt(event.target.value, 10) || 1)}
            className="h-7 w-20 rounded-md border border-white/[0.09] bg-black/[0.15] px-2 text-center font-mono text-[10px] text-text-main outline-none focus:border-emerald-400/50"
            aria-label={`${model} 权重`}
          />
          <span className="min-w-0 text-[9px] leading-3 text-text-muted">权重 3 接 3 个请求，权重 1 接 1 个</span>
        </div>
      )}
    </>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, onDelete, activeProviders, getCaps, combos = [], groupOptions = [], kindFilter = null }) {
  // Initialize state with combo values - key prop on parent handles reset on remount
  const [name, setName] = useState(combo?.name || "");
  const [models, setModels] = useState(combo?.models || []);
  const [groupName, setGroupName] = useState(combo?.groupName || "");
  const [sortOrder, setSortOrder] = useState(String(combo?.sortOrder ?? 0));
  const [accessTags, setAccessTags] = useState(combo?.accessTags || []);
  const [searchEnabled, setSearchEnabled] = useState(!!combo?.search);
  const searchProviders = getComboSearchProviders().filter(({ id }) => activeProviders.some((connection) => connection.provider === id && connection.isActive !== false));
  const [searchProvider, setSearchProvider] = useState(combo?.search?.provider || searchProviders[0]?.id || "");
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
  const memberCaps = models.map((entry) => getCaps?.(entry, {
    combos: combos.filter((candidate) => !combo || candidate.id !== combo.id),
    comboPath: [name.trim()],
  }));
  const capableMembers = {
    vision: memberCaps.filter((caps) => caps?.vision === true),
    audioInput: memberCaps.filter((caps) => caps?.audioInput === true),
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
    if (!combo) {
      const scheduleError = getComboScheduleValidationError(models);
      if (scheduleError) {
        alert(scheduleError);
        return;
      }
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
    const search = searchEnabled ? { mode: COMBO_SEARCH_MODE, provider: searchProvider, maxResults: COMBO_SEARCH_MAX_RESULTS } : null;
    const searchError = getComboSearchValidationError(search, {
      kind: combo?.kind, models, combos: combos.filter((candidate) => !combo || candidate.id !== combo.id), comboPath: [name.trim()],
    });
    if (searchError) { alert(searchError); return; }
    setSaving(true);
    await onSave({
      search,
      name: name.trim(),
      groupName: groupName.trim() || null,
      sortOrder: normalizedSortOrder,
      capabilities: { contextWindow, vision: capabilities.vision, audioInput: capabilities.audioInput },
      accessTags,
      ...(combo ? {} : { models }),
    });
    setSaving(false);
  };

  const isEdit = !!combo;
  const drawerActions = (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      {isEdit && (
        <Button
          type="button"
          onClick={onDelete}
          variant="outline"
          icon="delete"
          size="md"
          fullWidth
          className="border-red-400/20 bg-red-500/[0.035] text-red-300 hover:border-red-400/40 hover:bg-red-500/[0.08] sm:w-auto sm:min-w-28"
        >
          删除
        </Button>
      )}
      <div className="flex flex-1 gap-2 sm:ml-auto sm:flex-initial">
        <Button type="button" onClick={onClose} variant="secondary" fullWidth size="md" className="sm:w-auto sm:min-w-24">
          取消
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          fullWidth
          size="md"
          className="sm:w-auto sm:min-w-28"
          disabled={!name.trim() || !!nameError || saving}
        >
          {saving ? "保存中..." : isEdit ? "保存" : "创建"}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Drawer
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? "组合设置" : "创建组合"}
        width="lg"
        footer={drawerActions}
      >
        <div className="flex flex-col gap-3">
          <section className="rounded-lg border border-[#38bdf8]/15 bg-[#38bdf8]/[0.035] p-3">
            <div className="flex items-start gap-2.5">
              <span className="material-symbols-outlined mt-0.5 text-[18px] text-[#7dd3fc]">tune</span>
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-text-main">组合配置</h3>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  {isEdit
                    ? "维护组合名称、分组、排序与对外能力声明；模型排序和时段直接在路由节点列表调整。"
                    : "维护组合名称、分组、排序与对外能力声明。"}
                </p>
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

            <div className="mt-3 border-t border-[#38bdf8]/10 pt-3">
              <AccessTagsEditor
                value={accessTags}
                onChange={setAccessTags}
                label="模型权限标签"
                hint="设置后，只有拥有任一相同标签的 API 密钥可以看到和调用此模型组合；不设置则对所有密钥开放。"
              />
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

            <div className="mt-3 border-t border-[#38bdf8]/10 pt-3">
              <label className="flex items-center gap-2 text-sm font-medium text-text-main">
                <input type="checkbox" checked={searchEnabled} onChange={(event) => setSearchEnabled(event.target.checked)} />
                网关联网搜索
              </label>
              <p className="mt-1 text-[11px] text-text-muted">由网关调用已配置的专用搜索服务，模型按需搜索。需要工具调用节点；支持回退、轮询和自动路由，暂不支持融合策略。启用后流式回答会先缓冲，首字延迟较高。</p>
              {searchEnabled && (
                <label className="mt-2 flex flex-col gap-1">
                  <span className="text-xs text-text-muted">专用搜索通道</span>
                  <select aria-label="专用搜索通道" value={searchProvider} onChange={(event) => setSearchProvider(event.target.value)} className="h-9 w-full rounded-md border border-black/10 bg-white px-2 text-sm text-text-main dark:border-white/10 dark:bg-black/20">
                    <option value="">请选择已配置的搜索通道</option>
                    {searchProvider && !searchProviders.some(({ id }) => id === searchProvider) && <option value={searchProvider} disabled>{searchProvider}（未配置或已停用）</option>}
                    {searchProviders.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                  </select>
                  <span className="text-[10px] text-text-muted">{searchProviders.length ? `网关模式 · 每次最多 ${COMBO_SEARCH_MAX_RESULTS} 条结果` : "请先在通道页面配置专用搜索服务。"}</span>
                </label>
              )}
            </div>
          </section>

          {/* New combos still choose their initial nodes here; existing nodes are
              edited directly in the routing detail card. */}
          {!isEdit && (
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
                      getCaps={getCaps}
                      onEdit={(newVal) => {
                        const updated = [...models];
                        updated[index] = typeof models[index] === "object" && models[index] !== null
                          ? { ...models[index], model: newVal }
                          : newVal;
                        setModels(updated);
                      }}
                      onScheduleChange={(schedule) => {
                        const updated = [...models];
                        updated[index] = rebuildComboModelEntry(updated[index], { schedule });
                        setModels(updated);
                      }}
                      onAccessTagsChange={(accessTags) => {
                        const updated = [...models];
                        updated[index] = rebuildComboModelEntry(updated[index], { accessTags });
                        setModels(updated);
                      }}
                      onEffortChange={(effort) => {
                        const updated = [...models];
                        updated[index] = rebuildComboModelEntry(updated[index], { effort });
                        setModels(updated);
                      }}
                      onWeightChange={(weight) => {
                        const updated = [...models];
                        updated[index] = rebuildComboModelEntry(updated[index], { weight });
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
          )}

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
          availableModelsOnly
          addedModelValues={modelValues}
          closeOnSelect={false}
          presentation="drawer"
          drawerWidth="xl"
        />
      )}
    </>
  );
}
