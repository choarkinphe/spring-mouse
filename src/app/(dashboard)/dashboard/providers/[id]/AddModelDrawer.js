"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, Drawer, Input, Toggle } from "@/shared/components";
import {
  CAPABILITY_BOOLEAN_KEYS,
  CAPABILITY_GROUPS,
  capabilitiesFromDraft,
  createCapabilityDraft,
} from "@/shared/constants/modelCapabilities";

/**
 * Add-a-model drawer.
 *
 * Flow: type a model id (candidates come from the provider's own /models
 * endpoint) → test it → once the test passes the capability editor unlocks →
 * save writes the custom-model row and, when configured, its capability override.
 *
 * The caller mounts this conditionally with `key` tied to the open state, so the
 * draft state below is seeded exactly once per open and never needs a
 * reset-on-open effect (react-hooks/set-state-in-effect).
 */
export default function AddModelDrawer({
  isOpen,
  providerAlias,
  providerDisplayAlias,
  connections = [],
  canTest = true,
  existingModelIds,
  onSave,
  onClose,
}) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState(null); // null = not loaded yet
  const [testing, setTesting] = useState(false);
  const [verified, setVerified] = useState(false);
  const [testError, setTestError] = useState("");
  const [draft, setDraft] = useState(() => createCapabilityDraft({}));
  const [saving, setSaving] = useState(false);

  // Accept both "<alias>/<id>" and a bare id — the provider is already known here.
  const cleanId = useMemo(() => {
    const raw = query.trim();
    const prefix = `${providerAlias}/`;
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  }, [query, providerAlias]);

  const alreadyAdded = useMemo(
    () => (existingModelIds instanceof Set ? existingModelIds : new Set(existingModelIds || [])),
    [existingModelIds],
  );

  // Seed the search list from the first active account's /models endpoint.
  useEffect(() => {
    if (!isOpen) return undefined;
    const active = connections.find((connection) => connection.isActive !== false);
    if (!active) return undefined;
    let cancelled = false;
    fetch(`/api/providers/${active.id}/models`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        if (cancelled) return;
        const ids = (data.models || [])
          .map((model) => (typeof model === "string" ? model : model?.id || model?.name))
          .filter(Boolean);
        setCandidates([...new Set(ids)]);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, connections]);

  const matches = useMemo(() => {
    const q = cleanId.toLowerCase();
    if (!q || !candidates) return [];
    return candidates
      .filter((id) => id.toLowerCase().includes(q) && id.toLowerCase() !== q && !alreadyAdded.has(id))
      .slice(0, 8);
  }, [cleanId, candidates, alreadyAdded]);

  const resetVerification = () => {
    setVerified(false);
    setTestError("");
  };

  const handleChange = (value) => {
    setQuery(value);
    resetVerification();
  };

  const handlePick = (id) => {
    setQuery(id);
    resetVerification();
  };

  const handleTest = async () => {
    if (!cleanId || testing) return;
    setTesting(true);
    setTestError("");
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${cleanId}` }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        setVerified(true);
      } else {
        setVerified(false);
        setTestError(data.error || "测试未通过，该模型当前不可用。");
      }
    } catch (error) {
      setVerified(false);
      setTestError(error.message || "测试请求失败。");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!verified || saving) return;
    setSaving(true);
    try {
      const saved = await onSave({ id: cleanId, capabilities: capabilitiesFromDraft(draft) });
      if (saved !== false) onClose();
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setSaving(false);
    }
  };

  const setFlag = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const setNumber = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const activeCount = CAPABILITY_BOOLEAN_KEYS.filter((key) => draft[key]).length;
  const hasActiveConnection = connections.some((connection) => connection.isActive !== false);
  const duplicate = Boolean(cleanId) && alreadyAdded.has(cleanId);

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title="添加模型" width="lg">
      <div className="flex flex-col gap-6">
        {/* ── 1. 模型 ID + 上游搜索 ─────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <Input
            label="模型 ID"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleTest();
            }}
            placeholder="输入模型 ID 搜索，例如 gpt-4o"
            inputClassName="font-mono text-xs"
            icon="search"
            autoFocus
          />
          <p className="text-xs leading-relaxed text-text-muted">
            支持直接输入完整 ID。将以此 ID 发送：
            <code className="ml-1 rounded bg-surface-2 px-1 font-mono">{providerDisplayAlias}/{cleanId || "model-id"}</code>
          </p>

          {hasActiveConnection && candidates === null && (
            <p className="text-xs text-text-muted">正在读取上游 /models 列表…</p>
          )}

          {matches.length > 0 && (
            <div className="custom-scrollbar flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-[10px] border border-border-subtle bg-surface-2/40 p-1.5">
              {matches.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handlePick(id)}
                  className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="material-symbols-outlined shrink-0 text-[16px] text-text-muted">smart_toy</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-main" title={id}>{id}</span>
                  <span className="material-symbols-outlined shrink-0 text-[16px] text-text-muted">north_west</span>
                </button>
              ))}
            </div>
          )}

          {cleanId && candidates !== null && matches.length === 0 && !duplicate && (
            <p className="text-xs text-text-muted">上游列表没有匹配项，将按你输入的 ID 提交。</p>
          )}
          {duplicate && (
            <p className="text-xs text-warning">该模型已在此渠道中，请换一个 ID。</p>
          )}
          {!canTest && (
            <p className="text-xs text-warning">该渠道还没有可用账号，无法测试模型。</p>
          )}
        </section>

        {/* ── 2. 测试 ──────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="md"
              variant="secondary"
              icon="science"
              onClick={handleTest}
              loading={testing}
              disabled={!cleanId || testing || !canTest}
            >
              测试模型
            </Button>
            {verified && (
              <span className="inline-flex items-center gap-1 text-sm text-green-500">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                测试通过
              </span>
            )}
          </div>
          {testError && (
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-red-500">
              <span className="material-symbols-outlined shrink-0 text-[14px]">cancel</span>
              <span className="min-w-0 break-words">{testError}</span>
            </p>
          )}
        </section>

        {/* ── 3. 能力配置（测试通过后解锁） ─────────────────────────── */}
        {verified && (
          <section className="fade-in flex flex-col gap-4 border-t border-border-subtle pt-5">
            <div>
              <h3 className="text-sm font-semibold text-text-main">模型能力</h3>
              <p className="mt-0.5 text-xs text-text-muted">留空或全部关闭表示不覆盖，运行时将继续使用内置识别结果。</p>
            </div>

            {CAPABILITY_GROUPS.map((group) => (
              <div key={group.title} className="flex flex-col gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">{group.title}</h4>
                <div className="grid grid-cols-1 gap-2">
                  {group.items.map((item) => (
                    <div
                      key={item.key}
                      className="flex items-center justify-between gap-3 rounded-[10px] border border-border-subtle bg-bg/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-text-main">{item.label}</p>
                        <p className="truncate text-[11px] text-text-muted">{item.hint}</p>
                      </div>
                      <Toggle
                        size="sm"
                        checked={draft[item.key] === true}
                        onChange={(value) => setFlag(item.key, value)}
                        ariaLabel={`${item.label}：${draft[item.key] ? "已开启，点击关闭" : "已关闭，点击开启"}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="上下文长度 (tokens)"
                type="number"
                min="1"
                placeholder="留空使用内置默认值"
                value={draft.contextWindow}
                onChange={(e) => setNumber("contextWindow", e.target.value)}
                inputClassName="font-mono text-xs"
              />
              <Input
                label="最大输出 (tokens)"
                type="number"
                min="1"
                placeholder="留空使用内置默认值"
                value={draft.maxOutput}
                onChange={(e) => setNumber("maxOutput", e.target.value)}
                inputClassName="font-mono text-xs"
              />
            </div>

            <p className="text-xs text-text-muted">已开启 {activeCount} 项能力。</p>
          </section>
        )}

        {/* ── 底部操作 ─────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
          <div className="flex gap-2">
            <Button variant="ghost" fullWidth onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button fullWidth icon="add" loading={saving} disabled={!verified || saving || duplicate} onClick={handleSave}>
              添加模型
            </Button>
          </div>
          {!verified && <p className="text-center text-xs text-text-muted">测试通过后才能添加。</p>}
        </div>
      </div>
    </Drawer>
  );
}

AddModelDrawer.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  connections: PropTypes.arrayOf(PropTypes.object),
  canTest: PropTypes.bool,
  existingModelIds: PropTypes.instanceOf(Set),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
