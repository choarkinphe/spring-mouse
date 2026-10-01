"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  DashboardHero,
  ModuleSkeleton,
  Select,
  Toggle,
  Tooltip,
} from "@/shared/components";
import {
  BUILTIN_HARNESSES,
  resolveHarnessModelOptions,
  resolveHarnessProfiles,
} from "@/shared/utils/harnessRoute";

// How each `unavailableReason` from /api/combos/llm reads in the picker. A combo
// that cannot serve right now is still shown — a mapping is durable config, and
// a combo that is dark at 18:42 may be exactly the one wanted at 09:00 — but it
// is labelled so the operator is not surprised when it does not fire. The API
// filters out the structurally-unusable ones, so only schedule gaps arrive here.
const COMBO_UNAVAILABLE_LABEL = {
  "scheduled-out": "当前时段不可用",
};

// What each built-in tool should be told, so "one key and one base URL" is all
// an operator has to copy. `basePath` is appended to the origin.
const HARNESS_GUIDES = {
  "claude-desktop": {
    icon: "desktop_windows",
    description: "在 Claude Desktop 的「第三方推理」里填写网关地址，工具会用它的模型列表发起 Messages 请求。",
    basePath: "/claude-desktop/v1",
    example: "Base URL 填 ",
  },
  "claude-code": {
    icon: "terminal",
    description: "Claude Code 通过 ANTHROPIC_BASE_URL 接入，模型名由这里映射到真实通道。",
    basePath: "/claude-code/v1",
    example: "ANTHROPIC_BASE_URL=",
  },
  codex: {
    icon: "code",
    description: "Codex 使用 Responses 协议，指向该前缀后可用同一个 Key 调用任意通道。",
    basePath: "/codex/v1",
    example: "base_url 填 ",
  },
};

/**
 * One row of the mapping table: type the model the tool sends, pick what it
 * should actually run — a routing strategy (combo) or one of the models inside
 * one.
 *
 * The left side is a plain input rather than a dropdown. The tool's vocabulary
 * is open-ended: a release can start sending an id nobody listed, and a mapping
 * may legitimately be a wildcard (`claude-opus-*`). A closed `<select>` could
 * express neither without a detour through "自定义…", so the field accepts free
 * text and Tab completes it against the known ids — the list is a convenience,
 * not a fence.
 */
function MappingRow({
  mapping,
  modelOptions,
  knownModelOptions = modelOptions,
  targetOptions,
  disabled,
  onChange,
  onRemove,
  onAddModel,
}) {
  const [focused, setFocused] = useState(false);

  const value = mapping.match;
  const isKnownModel = knownModelOptions.includes(value);

  // The first known id that extends what has been typed, used for both the Tab
  // completion and the ghost suffix shown behind the caret. Matching is
  // case-insensitive so `Claude-Opus` still completes; the stored value keeps
  // whatever the operator typed. A value with surrounding whitespace is left
  // alone — the overlay aligns by character count, and a model id never has any.
  const completion = useMemo(() => {
    if (!value || value !== value.trim()) return null;
    const lower = value.toLowerCase();
    return (
      modelOptions.find(
        (model) => model.toLowerCase() !== lower && model.toLowerCase().startsWith(lower),
      ) || null
    );
  }, [value, modelOptions]);

  // Only offer the ghost while the field has focus: otherwise an unfocused row
  // would look like it already holds a longer value than it does.
  const ghost = focused && completion ? completion.slice(value.length) : "";

  // Saving the typed id into the maintained list is what makes it complete from
  // then on; the mapping itself is already set to it.
  const commitPendingModel = () => {
    if (value.trim() && !isKnownModel) onAddModel?.(value.trim());
  };

  const handleKeyDown = (event) => {
    if (event.key === "Tab" && completion && !event.shiftKey) {
      // Only swallow Tab when there is something to complete — otherwise the
      // operator would lose keyboard navigation out of the field.
      event.preventDefault();
      onChange({ ...mapping, match: completion });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commitPendingModel();
    }
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="relative">
          <input
            aria-label="客户端模型"
            placeholder="客户端模型名，如 claude-opus-5；输入后按 Tab 补全"
            value={value}
            disabled={disabled}
            onChange={(event) => onChange({ ...mapping, match: event.target.value })}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-xs text-text-main placeholder:text-text-muted focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
          />
          {ghost && (
            // Sits behind the input and never takes the pointer, so the
            // operator sees what Tab would insert without the field looking
            // like it already contains it.
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 flex items-center overflow-hidden px-3 font-mono text-xs"
            >
              <span className="invisible whitespace-pre">{value}</span>
              <span className="whitespace-pre text-text-muted/50">{ghost}</span>
            </span>
          )}
        </div>
        {completion && (
          <p className="flex items-center gap-1 text-[11px] leading-4 text-text-muted">
            <kbd className="rounded border border-border-subtle bg-surface-2 px-1 font-mono text-[10px]">Tab</kbd>
            <span>
              补全为 <code className="font-mono text-text-main">{completion}</code>
            </span>
          </p>
        )}
        {!isKnownModel && value.trim() && (
          <div className="flex items-center gap-1.5">
            <Tooltip text="把这个名字加进该工具的可补全列表，之后输入前缀即可 Tab 补全；只影响本页的选项，不会改动已保存的映射。">
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={commitPendingModel}
                aria-label="保存到模型列表"
              >
                <span className="material-symbols-outlined text-[18px]">bookmark_add</span>
              </Button>
            </Tooltip>
            <span className="text-[11px] leading-4 text-text-muted">
              或直接使用通配（如 <code className="font-mono">claude-opus-*</code>）
            </span>
          </div>
        )}
      </div>

      <span className="hidden shrink-0 pt-2.5 text-text-muted sm:block" aria-hidden="true">→</span>

      <div className="min-w-0 flex-1">
        <Select
          aria-label="映射到的目标"
          value={mapping.target}
          disabled={disabled}
          onChange={(event) => onChange({ ...mapping, target: event.target.value })}
          options={targetOptions}
          placeholder="选择组合或模型"
          selectClassName="font-mono text-xs"
        />
      </div>

      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onRemove}
        aria-label="删除该映射"
        className="shrink-0 self-start sm:mt-0.5"
      >
        <span className="material-symbols-outlined text-[18px]">delete</span>
      </Button>
    </div>
  );
}

function HarnessRail({ profiles, activePrefix, onSelect }) {
  return (
    <aside
      aria-label="Harness 列表"
      className="flex min-w-0 flex-col rounded-xl border border-border-subtle bg-surface/35 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.065] p-2.5">
        <p className="mr-auto font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#647688]">
          外部工具
        </p>
      </div>
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5">
        <div className="flex flex-col gap-1">
          {BUILTIN_HARNESSES.map((harness) => {
            const profile = profiles[harness.prefix] || {};
            const guide = HARNESS_GUIDES[harness.prefix] || {};
            const isActive = harness.prefix === activePrefix;
            const isEnabled = profile.enabled !== false;
            const count = (profile.mappings || []).length;
            return (
              <button
                key={harness.prefix}
                type="button"
                onClick={() => onSelect(harness.prefix)}
                aria-current={isActive ? "true" : undefined}
                className={`group flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors ${
                  isActive
                    ? "border-[#38bdf8]/35 bg-[#38bdf8]/[0.08] text-text-main"
                    : "border-transparent text-text-muted hover:bg-white/[0.04] hover:text-text-main"
                }`}
              >
                <span
                  className={`material-symbols-outlined shrink-0 text-[18px] ${isActive ? "text-[#7dd3fc]" : "text-[#647688]"}`}
                >
                  {guide.icon || "extension"}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium">
                    {profile.label || harness.label}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-[#647688]">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${isEnabled ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)]" : "bg-slate-500"}`}
                      title={isEnabled ? "已启用" : "已停用"}
                    />
                    <span className="truncate">{count} 条映射</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="shrink-0 border-t border-white/[0.065] px-3.5 py-2 text-[10px] text-[#647688]">
        共 <span className="font-mono tabular-nums text-text-muted">{BUILTIN_HARNESSES.length}</span> 个内置工具
      </div>
    </aside>
  );
}

function HarnessDetail({
  harness, profile, combos, customModels, discoveredModels, modelSource, refreshingModels,
  saving, status, onSave, onRefreshModels, onChange, onAddModel, onDeleteModel,
}) {
  const guide = HARNESS_GUIDES[harness.prefix] || {};
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setOrigin(window.location.origin), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const enabled = profile.enabled !== false;
  // Stable identity for the mapping list so the derived options below do not
  // recompute on every render.
  const mappings = useMemo(() => profile.mappings || [], [profile.mappings]);
  const knownModelOptions = useMemo(
    () => resolveHarnessModelOptions(harness.prefix, customModels, discoveredModels || []),
    [harness.prefix, customModels, discoveredModels],
  );
  const modelOptions = useMemo(
    () => [...new Set([
      ...knownModelOptions,
      ...mappings.map((mapping) => mapping.match).filter((match) => match && !match.includes("*")),
    ])],
    [knownModelOptions, mappings],
  );
  // `customModels` is the whole per-prefix map; the panel below needs just this
  // harness's own list.
  const customModelList = useMemo(() => {
    const list = customModels?.[harness.prefix];
    return Array.isArray(list) ? list : [];
  }, [customModels, harness.prefix]);
  const basePath = guide.basePath || `/${harness.prefix}/v1`;
  const baseUrl = `${origin}${basePath}`;

  // The right-hand picker offers everything 路由策略 has configured and enabled:
  // first the combos themselves (the usual target), then the individual member
  // models those combos are built from. A target may be either a combo name or a
  // `provider/model`, and pointing a tool straight at a model should not require
  // inventing a one-member combo first — so the member ids are selectable too,
  // grouped so the two kinds never blur together.
  const targetOptions = useMemo(() => {
    const comboOptions = [];
    const memberOptions = [];
    const seenMembers = new Set();

    for (const combo of combos) {
      if (!combo || typeof combo.name !== "string" || !combo.name.trim()) continue;

      const count = typeof combo.activeModelCount === "number" ? combo.activeModelCount : null;
      // Every combo is listed; an unavailable one is annotated rather than
      // hidden, because a mapping is durable config and the dark combo may be
      // exactly what the operator wants to map for its active window.
      if (combo.available === false) {
        const reason = COMBO_UNAVAILABLE_LABEL[combo.unavailableReason] || "当前不可用";
        comboOptions.push({
          value: combo.name,
          label: `${combo.name}（${reason}）`,
          group: "模型组合",
        });
      } else {
        comboOptions.push({
          value: combo.name,
          label: count === null ? combo.name : `${combo.name}（${count} 个可用模型）`,
          group: "模型组合",
        });
      }

      // A combo name is also a valid value here, and a member id may repeat
      // across combos — each value must appear once or the picker would show
      // duplicates for one choice.
      const members = Array.isArray(combo.models) ? combo.models : [];
      for (const model of members) {
        if (typeof model !== "string" || !model.trim()) continue;
        const id = model.trim();
        if (seenMembers.has(id) || id === combo.name) continue;
        seenMembers.add(id);
        memberOptions.push({ value: id, label: id, group: "组合内模型" });
      }
    }

    return [...comboOptions, ...memberOptions];
  }, [combos]);

  // A mapping may still point at a combo that has since been renamed or removed.
  // Surface it as an option so the row shows the real stored value instead of
  // silently snapping to the placeholder.
  const rows = useMemo(() => {
    const known = new Set(targetOptions.map((option) => option.value));
    return mappings.map((mapping) => {
      if (!mapping.target || known.has(mapping.target)) return { mapping, options: targetOptions };
      return {
        mapping,
        options: [
          ...targetOptions,
          { value: mapping.target, label: `${mapping.target}（已失效）` },
        ],
      };
    });
  }, [mappings, targetOptions]);

  const updateMappings = (next) => onChange({ ...profile, mappings: next });

  return (
    <section aria-label={`${harness.label} Harness 配置`} className="flex min-w-0 flex-col gap-4">
      <Card
        title={profile.label || harness.label}
        subtitle={guide.description}
        icon={guide.icon}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={enabled ? "success" : "default"}>
              {enabled ? "已启用" : "已停用"}
            </Badge>
            <Toggle
              checked={enabled}
              disabled={saving}
              onChange={(value) => onChange({ ...profile, enabled: value })}
              ariaLabel={`启用 ${harness.label}`}
            />
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Card.Section className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-muted">接入地址</span>
            <code className="block break-all rounded-[8px] bg-surface-2 px-3 py-2 font-mono text-xs text-text-main">
              {baseUrl}
            </code>
            <p className="text-xs leading-5 text-text-muted">{guide.example}{baseUrl}</p>
          </Card.Section>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-text-main">模型映射</span>
                <Tooltip text="左侧填该工具请求里带的模型名，输入后按 Tab 从已知列表补全，也可以直接写通配（claude-opus-*）或任意新名字。右侧选它实际要调用的目标：可以是「路由策略」里的组合，也可以是组合中已启用的某个模型（provider/model）。">
                  <span className="material-symbols-outlined cursor-help text-[16px] text-text-muted">help</span>
                </Tooltip>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!enabled || saving}
                onClick={() => updateMappings([...mappings, { match: "", target: "" }])}
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                添加映射
              </Button>
            </div>

            {mappings.length === 0 ? (
              <p className="rounded-[10px] border border-dashed border-border-subtle px-3 py-4 text-center text-xs text-text-muted">
                未配置映射。该工具的模型名将按原有规则解析。
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {rows.map(({ mapping, options }, index) => (
                  <MappingRow
                    // Rows are positional and freely reordered by delete/add, so
                    // the index is the stable identity here.
                    key={index}
                    mapping={mapping}
                    modelOptions={modelOptions}
                    knownModelOptions={knownModelOptions}
                    targetOptions={options}
                    disabled={!enabled || saving}
                    onChange={(next) => {
                      const copy = [...mappings];
                      copy[index] = next;
                      updateMappings(copy);
                    }}
                    onRemove={() => updateMappings(mappings.filter((_, i) => i !== index))}
                    onAddModel={onAddModel}
                  />
                ))}
              </div>
            )}

            {combos.length === 0 && (
              <p className="text-xs leading-5 text-amber-400/90">
                还没有模型组合，请先在「路由策略」里创建一个。
              </p>
            )}
          </div>

          <Card.Section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-text-main">模型提示 / 自定义模型名</span>
                <Tooltip text="自动合并公共模型目录、渠道已同步的名字和本地目录，新版本优先。公共目录可能延迟收录；仍可直接输入任意名字或通配。">
                  <span className="material-symbols-outlined cursor-help text-[16px] text-text-muted">help</span>
                </Tooltip>
              </div>
              <Button variant="ghost" size="sm" onClick={onRefreshModels} disabled={refreshingModels}>
                <span className="material-symbols-outlined text-[18px]">refresh</span>
                {refreshingModels ? "获取中…" : "刷新模型提示"}
              </Button>
            </div>
            <p className="text-xs leading-5 text-text-muted" role="status">
              {refreshingModels ? "正在获取模型目录…" : modelSource === "catalog"
                ? "已合并公共模型目录（缓存 10 分钟）与本地列表"
                : "公共目录暂不可用，使用本地目录与离线提示"}
              ；共 {modelOptions.length} 个提示。自定义名字会追加到 Tab 补全列表。
            </p>
            {customModelList.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {customModelList.map((model) => (
                  <span
                    key={model}
                    className="inline-flex items-center gap-1 rounded-[8px] border border-border-subtle bg-surface-2 py-1 pl-2 pr-1 font-mono text-[11px] text-text-main"
                  >
                    {model}
                    <button
                      type="button"
                      onClick={() => onDeleteModel(model)}
                      disabled={saving}
                      aria-label={`删除自定义模型名 ${model}`}
                      className="flex size-4 items-center justify-center rounded text-text-muted hover:bg-white/[0.06] hover:text-red-400"
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="text-[11px] leading-4 text-text-muted">
              点击下方按钮，仅保存当前工具的映射、启用状态和自定义模型名。
            </p>
          </Card.Section>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
            <div role="status" className={`text-xs ${status?.type === "error" ? "text-red-400" : "text-emerald-400"}`}>
              {status?.message}
            </div>
            <Button onClick={onSave} disabled={saving}>
              {saving ? "保存中…" : `保存 ${harness.label} 配置`}
            </Button>
          </div>
        </div>
      </Card>
    </section>
  );
}

export default function HarnessPageClient() {
  const [profiles, setProfiles] = useState({});
  const [customModels, setCustomModels] = useState({});
  const [combos, setCombos] = useState([]);
  const [activePrefix, setActivePrefix] = useState(BUILTIN_HARNESSES[0].prefix);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [statuses, setStatuses] = useState({});
  const [loadError, setLoadError] = useState("");
  const [modelHints, setModelHints] = useState({});
  const [modelSources, setModelSources] = useState({});
  const [refreshingModels, setRefreshingModels] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [settingsResponse, combosResponse] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        // `includeUnavailable` lists every LLM combo with an availability flag,
        // so the picker can show the dark ones annotated instead of hiding them.
        // `includeMembers` attaches each combo's member ids, so the same picker
        // can also offer a single `provider/model` target — everything the
        // 路由策略 page has configured and enabled, not just the combo names.
        fetch("/api/combos/llm?includeUnavailable=1&includeMembers=1", { cache: "no-store" }),
      ]);
      if (!settingsResponse.ok || !combosResponse.ok) throw new Error("无法读取 Harness 配置");
      const settings = await settingsResponse.json();
      const comboData = await combosResponse.json();

      const stored = resolveHarnessProfiles(settings);
      // Materialize every built-in harness so the rail is stable before the
      // first save; a stored profile only overrides what it actually sets.
      const merged = {};
      for (const harness of BUILTIN_HARNESSES) {
        const existing = stored[harness.prefix];
        merged[harness.prefix] = {
          enabled: existing?.enabled !== false,
          label: existing?.label || harness.label,
          mappings: Array.isArray(existing?.mappings) ? existing.mappings : [],
        };
      }
      setProfiles(merged);
      setCustomModels(
        settings.harnessModels && typeof settings.harnessModels === "object"
          ? settings.harnessModels
          : {},
      );
      setCombos(Array.isArray(comboData.combos) ? comboData.combos : []);
    } catch (error) {
      console.error("Failed to load harness profiles:", error);
      setLoadError("无法读取 Harness 配置，请重试；未加载成功前不会覆盖现有配置。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = setTimeout(() => void load(), 0);
    return () => clearTimeout(task);
  }, [load]);

  const refreshModels = useCallback(async () => {
    setRefreshingModels(true);
    try {
      const response = await fetch("/api/harnesses/models", { cache: "no-store" });
      if (!response.ok) throw new Error("模型目录暂不可用");
      const data = await response.json();
      setModelHints(data.models || {});
      setModelSources(data.sources || {});
    } catch {
      // Keep any previous vocabulary; free text and offline hints always work.
      setModelSources({});
    } finally {
      setRefreshingModels(false);
    }
  }, []);

  useEffect(() => {
    const task = setTimeout(() => void refreshModels(), 0);
    return () => clearTimeout(task);
  }, [refreshModels]);

  const clearStatus = (prefix) => setStatuses((current) => ({ ...current, [prefix]: {} }));

  const updateProfile = (prefix, next) => {
    clearStatus(prefix);
    setProfiles((current) => ({ ...current, [prefix]: next }));
  };

  const addCustomModel = (prefix, model) => {
    const value = typeof model === "string" ? model.trim() : "";
    if (!value) return;
    clearStatus(prefix);
    setCustomModels((current) => {
      const list = Array.isArray(current[prefix]) ? current[prefix] : [];
      if (list.includes(value)) return current;
      return { ...current, [prefix]: [...list, value] };
    });
  };

  const deleteCustomModel = (prefix, model) => {
    clearStatus(prefix);
    setCustomModels((current) => {
      const list = Array.isArray(current[prefix]) ? current[prefix] : [];
      const next = list.filter((item) => item !== model);
      if (next.length === list.length) return current;
      const copy = { ...current };
      // Drop the key entirely when it empties: `normalizeHarnessModels` omits
      // empty lists anyway, so keeping `[]` would only differ on a reload.
      if (next.length === 0) delete copy[prefix];
      else copy[prefix] = next;
      return copy;
    });
  };

  const save = async (prefix) => {
    setSaving((current) => ({ ...current, [prefix]: true }));
    clearStatus(prefix);
    try {
      const profile = profiles[prefix];
      const response = await fetch(`/api/harnesses/${prefix}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: {
            ...profile,
            mappings: (profile.mappings || []).filter(
              (mapping) => mapping.match.trim() && mapping.target.trim(),
            ),
          },
          models: customModels[prefix] || [],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "保存 Harness 配置失败");
      setProfiles((current) => ({ ...current, [prefix]: data.profile }));
      setCustomModels((current) => ({ ...current, [prefix]: data.models }));
      const label = BUILTIN_HARNESSES.find((harness) => harness.prefix === prefix)?.label;
      setStatuses((current) => ({ ...current, [prefix]: { type: "success", message: `${label} 配置已保存` } }));
    } catch (error) {
      setStatuses((current) => ({ ...current, [prefix]: { type: "error", message: error.message || "保存 Harness 配置失败" } }));
    } finally {
      setSaving((current) => ({ ...current, [prefix]: false }));
    }
  };

  // Derived selection: an unknown prefix falls back to the first harness, so no
  // effect has to keep the id and the list in sync.
  const activeHarness =
    BUILTIN_HARNESSES.find((harness) => harness.prefix === activePrefix) || BUILTIN_HARNESSES[0];
  const activeProfile = profiles[activeHarness.prefix] || {
    enabled: true,
    label: activeHarness.label,
    mappings: [],
  };
  const configuredCount = BUILTIN_HARNESSES.filter(
    (harness) => (profiles[harness.prefix]?.mappings || []).length > 0,
  ).length;

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <DashboardHero
        eyebrow="HARNESS"
        title="Harness"
        description="让外部工具用同一个 Key 接入：给每个工具一个专属地址，由服务端把它的模型名映射到真实组合。"
        icon="extension"
      >
        <Badge variant="primary" size="md" icon="extension">
          {BUILTIN_HARNESSES.length} 个内置工具
        </Badge>
        <Badge variant={configuredCount > 0 ? "success" : "default"} size="md" icon="route">
          {configuredCount} 个已配置映射
        </Badge>
      </DashboardHero>

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-[10px] border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {loadError}
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>重试</Button>
        </div>
      )}

      {loading ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6">
          <ModuleSkeleton title="正在加载外部工具" icon="extension" lines={4} className="min-h-[240px]" />
          <ModuleSkeleton title="正在读取模型映射" icon="route" lines={6} className="min-h-[320px]" />
        </div>
      ) : loadError ? null : (
        // Mirrors the channel list: a harness rail on the left, the selected
        // tool's address and mapping table on the right.
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6">
          <HarnessRail
            profiles={profiles}
            activePrefix={activeHarness.prefix}
            onSelect={setActivePrefix}
          />
          <HarnessDetail
            key={activeHarness.prefix}
            harness={activeHarness}
            profile={activeProfile}
            combos={combos}
            customModels={customModels}
            discoveredModels={modelHints[activeHarness.prefix]}
            modelSource={modelSources[activeHarness.prefix]}
            refreshingModels={refreshingModels}
            saving={saving[activeHarness.prefix] === true}
            status={statuses[activeHarness.prefix]}
            onSave={() => save(activeHarness.prefix)}
            onRefreshModels={refreshModels}
            onChange={(next) => updateProfile(activeHarness.prefix, next)}
            onAddModel={(model) => addCustomModel(activeHarness.prefix, model)}
            onDeleteModel={(model) => deleteCustomModel(activeHarness.prefix, model)}
          />
        </div>
      )}
    </div>
  );
}
