"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  DashboardHero,
  Input,
  Toggle,
  Tooltip,
} from "@/shared/components";
import { BUILTIN_HARNESSES } from "@/shared/utils/harnessRoute";

// What each built-in tool should be told, so "one key and one base URL" is all
// an operator has to copy. `path` is appended to the origin.
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

const emptyMapping = () => ({ match: "", target: "" });

function MappingRow({ mapping, disabled, onChange, onRemove, canRemove }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        aria-label="客户端模型名"
        placeholder="claude-opus-*"
        value={mapping.match}
        disabled={disabled}
        onChange={(event) => onChange({ ...mapping, match: event.target.value })}
        className="sm:flex-1"
        inputClassName="font-mono text-xs"
      />
      <span className="hidden shrink-0 text-text-muted sm:block" aria-hidden="true">→</span>
      <Input
        aria-label="映射目标"
        placeholder="cx/gpt-5.6-sol 或组合名"
        value={mapping.target}
        disabled={disabled}
        onChange={(event) => onChange({ ...mapping, target: event.target.value })}
        className="sm:flex-1"
        inputClassName="font-mono text-xs"
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || !canRemove}
        onClick={onRemove}
        aria-label="删除该映射"
        className="shrink-0 self-end sm:self-auto"
      >
        <span className="material-symbols-outlined text-[18px]">delete</span>
      </Button>
    </div>
  );
}

function HarnessCard({ harness, profile, combos, onChange, saving }) {
  const guide = HARNESS_GUIDES[harness.prefix] || {};
  const enabled = profile.enabled !== false;
  const mappings = profile.mappings || [];

  const comboNames = useMemo(() => combos.map((combo) => combo.name), [combos]);

  const basePath = guide.basePath || `/${harness.prefix}/v1`;

  const updateMappings = (next) => onChange({ ...profile, mappings: next });

  return (
    <Card
      title={profile.label || harness.label}
      subtitle={guide.description}
      icon={guide.icon}
      action={
        <div className="flex items-center gap-3">
          {saving && <span className="text-xs text-text-muted">保存中…</span>}
          <Toggle
            checked={enabled}
            onChange={(value) => onChange({ ...profile, enabled: value })}
            ariaLabel={`启用 ${harness.label}`}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Card.Section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-muted">接入地址</span>
            <Badge variant={enabled ? "success" : "default"}>
              {enabled ? "已启用" : "已停用"}
            </Badge>
          </div>
          <code className="block break-all rounded-[8px] bg-surface-2 px-3 py-2 font-mono text-xs text-text-main">
            https://你的域名{basePath}
          </code>
          <p className="text-xs leading-5 text-text-muted">{guide.example}</p>
        </Card.Section>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-text-main">模型映射</span>
              <Tooltip text="支持 * 前缀/后缀通配；精确匹配优先于通配。目标可填 provider/model 或组合名。">
                <span className="material-symbols-outlined cursor-help text-[16px] text-text-muted">help</span>
              </Tooltip>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={!enabled}
              onClick={() => updateMappings([...mappings, emptyMapping()])}
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
            <div className="flex flex-col gap-2">
              {mappings.map((mapping, index) => (
                <MappingRow
                  // Rows are positional and freely reordered by delete/add, so
                  // the index is the stable identity here.
                  key={index}
                  mapping={mapping}
                  disabled={!enabled}
                  canRemove={mappings.length > 1}
                  onChange={(next) => {
                    const copy = [...mappings];
                    copy[index] = next;
                    updateMappings(copy);
                  }}
                  onRemove={() => updateMappings(mappings.filter((_, i) => i !== index))}
                />
              ))}
            </div>
          )}

          {mappings.length > 0 && comboNames.length > 0 && (
            <p className="text-xs leading-5 text-text-muted">
              可用组合：{comboNames.slice(0, 6).join("、")}
              {comboNames.length > 6 ? ` 等 ${comboNames.length} 个` : ""}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function HarnessPageClient() {
  const [profiles, setProfiles] = useState({});
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResponse, combosResponse] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/combos/llm", { cache: "no-store" }),
      ]);
      const settings = settingsResponse.ok ? await settingsResponse.json() : {};
      const comboData = combosResponse.ok ? await combosResponse.json() : {};

      const stored = settings.harnessProfiles && typeof settings.harnessProfiles === "object"
        ? settings.harnessProfiles
        : {};
      // Materialize every built-in harness so the page is stable before the
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
        body: JSON.stringify({ harnessProfiles: payload }),
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

  return (
    <div className="flex flex-col gap-4">
      <DashboardHero
        eyebrow="HARNESS"
        title="Harness 支持"
        description="让外部工具用同一个 Key 接入：给每个工具一个专属地址，由服务端把它的模型名映射到真实通道。"
        icon="extension"
        action={
          <Button onClick={save} disabled={loading || saving}>
            {saving ? "保存中…" : "保存配置"}
          </Button>
        }
      />

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
        <p className="px-1 text-sm text-text-muted">正在读取配置…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {BUILTIN_HARNESSES.map((harness) => (
            <HarnessCard
              key={harness.prefix}
              harness={harness}
              profile={profiles[harness.prefix] || { enabled: true, label: harness.label, mappings: [] }}
              combos={combos}
              saving={saving}
              onChange={(next) => updateProfile(harness.prefix, next)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
