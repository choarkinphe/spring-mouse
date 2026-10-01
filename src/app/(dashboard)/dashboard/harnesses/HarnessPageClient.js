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
  HARNESS_MODEL_OPTIONS,
  resolveHarnessModelOptions,
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
    example: "Base URL 填 https://你的域名/claude-desktop/v1",
  },
  "claude-code": {
    icon: "terminal",
    description: "Claude Code 通过 ANTHROPIC_BASE_URL 接入，模型名由这里映射到真实通道。",
    basePath: "/claude-code/v1",
    example: "ANTHROPIC_BASE_URL=https://你的域名/claude-code/v1",
  },
  codex: {
    icon: "code",
    description: "Codex 使用 Responses 协议，指向该前缀后可用同一个 Key 调用任意通道。",
    basePath: "/codex/v1",
    example: "base_url 填 https://你的域名/codex/v1",
  },
};

/**
 * One row of the mapping table: pick a model the tool knows about, pick the
 * combo it should actually run. The left side is a fixed list because it is the
 * tool's own vocabulary — free text there would only ever be a typo.
 */
function MappingRow({
  mapping,
  modelOptions,
  comboOptions,
  disabled,
  onChange,
  onRemove,
  onAddModel,
  onDeleteModel,
}) {
  const [customModel, setCustomModel] = useState(false);

  const isKnownModel = modelOptions.includes(mapping.match);
  // Rows are keyed by index, so a delete can hand this component's state to a
  // different mapping. Deriving from `isKnownModel` keeps a stale flag harmless:
  // a known model always renders the dropdown, whatever the leftover state says.
  const showCustom = !isKnownModel && (customModel || Boolean(mapping.match));

  const modelValue = showCustom ? "__custom__" : mapping.match;

  // Saving the typed id into the maintained list is what makes it selectable
  // from then on; the mapping itself is already set to it.
  const commitPendingModel = () => onAddModel?.(mapping.match);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Select
          aria-label="客户端模型"
          value={modelValue}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === "__custom__") {
              setCustomModel(true);
              return;
            }
            setCustomModel(false);
            onChange({ ...mapping, match: event.target.value });
          }}
          options={[
            ...modelOptions.map((model) => ({ value: model, label: model })),
            { value: "__custom__", label: "自定义…" },
          ]}
          placeholder="选择模型"
          selectClassName="font-mono text-xs"
        />
        {showCustom && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <input
                aria-label="自定义模型名"
                placeholder="claude-opus-5"
                value={mapping.match}
                disabled={disabled}
                onChange={(event) => onChange({ ...mapping, match: event.target.value })}
                className="min-w-0 flex-1 rounded-[10px] border border-transparent bg-surface-2 px-3 py-2 font-mono text-xs text-text-main placeholder:text-text-muted focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
              />
              <Tooltip text="把这个名字加进该工具的下拉列表，之后可以直接选；只影响本页的选项，不会改动已保存的映射。">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || !mapping.match.trim()}
                  onClick={commitPendingModel}
                  aria-label="保存到模型列表"
                >
                  <span className="material-symbols-outlined text-[18px]">bookmark_add</span>
                </Button>
              </Tooltip>
            </div>
            <p className="text-[11px] leading-4 text-text-muted">
              也可以直接在这里输入通配（如 <code className="font-mono">claude-opus-*</code>），不加入列表。
            </p>
          </div>
        )}
      </div>

      <span className="hidden shrink-0 pt-2.5 text-text-muted sm:block" aria-hidden="true">→</span>

      <div className="min-w-0 flex-1">
        <Select
          aria-label="映射到的组合"
          value={mapping.target}
          disabled={disabled}
          onChange={(event) => onChange({ ...mapping, target: event.target.value })}
          options={comboOptions}
          placeholder="选择组合"
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

function HarnessDetail({ harness, profile, combos, customModels, onChange, onAddModel, onDeleteModel }) {
  const guide = HARNESS_GUIDES[harness.prefix] || {};
  const enabled = profile.enabled !== false;
  // Stable identity for the mapping list so the derived options below do not
  // recompute on every render.
  const mappings = useMemo(() => profile.mappings || [], [profile.mappings]);
  const builtinModels = HARNESS_MODEL_OPTIONS[harness.prefix] || [];
  const modelOptions = useMemo(
    () => resolveHarnessModelOptions(harness.prefix, customModels),
    [harness.prefix, customModels],
  );
  // `customModels` is the whole per-prefix map; the panel below needs just this
  // harness's own list.
  const customModelList = useMemo(() => {
    const list = customModels?.[harness.prefix];
    return Array.isArray(list) ? list : [];
  }, [customModels, harness.prefix]);
  const basePath = guide.basePath || `/${harness.prefix}/v1`;

  const comboOptions = useMemo(
    () =>
      combos
        .filter((combo) => combo && typeof combo.name === "string" && combo.name.trim())
        .map((combo) => {
          const count =
            typeof combo.activeModelCount === "number" ? combo.activeModelCount : null;
          // Every combo is listed; an unavailable one is annotated rather than
          // hidden, because a mapping is durable config and the dark combo may
          // be exactly what the operator wants to map for its active window.
          if (combo.available === false) {
            const reason = COMBO_UNAVAILABLE_LABEL[combo.unavailableReason] || "当前不可用";
            return { value: combo.name, label: `${combo.name}（${reason}）` };
          }
          return {
            value: combo.name,
            label: count === null ? combo.name : `${combo.name}（${count} 个可用模型）`,
          };
        }),
    [combos],
  );

  // A mapping may still point at a combo that has since been renamed or removed.
  // Surface it as an option so the row shows the real stored value instead of
  // silently snapping to the placeholder.
  const rows = useMemo(() => {
    const known = new Set(comboOptions.map((option) => option.value));
    return mappings.map((mapping) => {
      if (!mapping.target || known.has(mapping.target)) return { mapping, options: comboOptions };
      return {
        mapping,
        options: [
          ...comboOptions,
          { value: mapping.target, label: `${mapping.target}（已失效）` },
        ],
      };
    });
  }, [mappings, comboOptions]);

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
              https://你的域名{basePath}
            </code>
            <p className="text-xs leading-5 text-text-muted">{guide.example}</p>
          </Card.Section>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-text-main">模型映射</span>
                <Tooltip text="左侧是该工具自带的模型名，右侧选择它实际要调用的组合。工具升级换模型名时，用「自定义…」补一条即可。">
                  <span className="material-symbols-outlined cursor-help text-[16px] text-text-muted">help</span>
                </Tooltip>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!enabled}
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
                    comboOptions={options}
                    disabled={!enabled}
                    onChange={(next) => {
                      const copy = [...mappings];
                      copy[index] = next;
                      updateMappings(copy);
                    }}
                    onRemove={() => updateMappings(mappings.filter((_, i) => i !== index))}
                    onAddModel={onAddModel}
                    onDeleteModel={onDeleteModel}
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
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-text-main">自定义模型名</span>
              <Tooltip text="左侧下拉默认只列出该工具内置的模型名。工具升级后开始发送新的模型名时，在这里保存一次，之后就能直接从下拉里选。">
                <span className="material-symbols-outlined cursor-help text-[16px] text-text-muted">help</span>
              </Tooltip>
            </div>
            <p className="text-xs leading-5 text-text-muted">
              内置 {builtinModels.length} 个；这里保存的名字会追加到左侧下拉列表。
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
              保存配置后生效。
            </p>
          </Card.Section>
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
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResponse, combosResponse] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        // `includeUnavailable` lists every LLM combo with an availability flag,
        // so the picker can show the dark ones annotated instead of hiding them.
        fetch("/api/combos/llm?includeUnavailable=1", { cache: "no-store" }),
      ]);
      const settings = settingsResponse.ok ? await settingsResponse.json() : {};
      const comboData = combosResponse.ok ? await combosResponse.json() : {};

      const stored = settings.harnessProfiles && typeof settings.harnessProfiles === "object"
        ? settings.harnessProfiles
        : {};
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
      setStatus({ type: "error", message: "无法读取 Harness 配置" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = setTimeout(() => void load(), 0);
    return () => clearTimeout(task);
  }, [load]);

  const updateProfile = (prefix, next) => {
    setProfiles((current) => ({ ...current, [prefix]: next }));
  };

  const addCustomModel = (prefix, model) => {
    const value = typeof model === "string" ? model.trim() : "";
    if (!value) return;
    setCustomModels((current) => {
      const list = Array.isArray(current[prefix]) ? current[prefix] : [];
      if (list.includes(value)) return current;
      return { ...current, [prefix]: [...list, value] };
    });
  };

  const deleteCustomModel = (prefix, model) => {
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

  const save = async () => {
    setSaving(true);
    setStatus({ type: "", message: "" });
    try {
      // Drop blank rows so an unfinished input never blocks the save.
      const payload = {};
      for (const [prefix, profile] of Object.entries(profiles)) {
        payload[prefix] = {
          ...profile,
          mappings: (profile.mappings || []).filter(
            (mapping) => mapping.match.trim() && mapping.target.trim(),
          ),
        };
      }
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harnessProfiles: payload, harnessModels: customModels }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "保存 Harness 配置失败");
      setStatus({ type: "success", message: "Harness 配置已保存" });
      await load();
    } catch (error) {
      setStatus({ type: "error", message: error.message || "保存 Harness 配置失败" });
    } finally {
      setSaving(false);
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
        action={
          <Button onClick={save} disabled={loading || saving}>
            {saving ? "保存中…" : "保存配置"}
          </Button>
        }
      >
        <Badge variant="primary" size="md" icon="extension">
          {BUILTIN_HARNESSES.length} 个内置工具
        </Badge>
        <Badge variant={configuredCount > 0 ? "success" : "default"} size="md" icon="route">
          {configuredCount} 个已配置映射
        </Badge>
      </DashboardHero>

      {status.message && (
        <div
          role="status"
          className={
            status.type === "error"
              ? "rounded-[10px] border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400"
              : "rounded-[10px] border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-400"
          }
        >
          {status.message}
        </div>
      )}

      {loading ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6">
          <ModuleSkeleton title="正在加载外部工具" icon="extension" lines={4} className="min-h-[240px]" />
          <ModuleSkeleton title="正在读取模型映射" icon="route" lines={6} className="min-h-[320px]" />
        </div>
      ) : (
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
            onChange={(next) => updateProfile(activeHarness.prefix, next)}
            onAddModel={(model) => addCustomModel(activeHarness.prefix, model)}
            onDeleteModel={(model) => deleteCustomModel(activeHarness.prefix, model)}
          />
        </div>
      )}
    </div>
  );
}
