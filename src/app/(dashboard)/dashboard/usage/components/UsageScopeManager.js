"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import useSettingsStore from "@/store/settingsStore";
import { hasAccessTagOverlap, normalizeAccessTags } from "@/shared/utils/accessTags";

function ScopeStatus({ tags, matchedUserCount }) {
  const unrestricted = tags.length === 0;
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold ${unrestricted ? "bg-emerald-500/10 text-emerald-500" : "bg-primary/10 text-primary"}`}>
      <span className="material-symbols-outlined text-[15px]">{unrestricted ? "groups" : "filter_alt"}</span>
      <span className="truncate">{unrestricted ? "全部使用人" : `${tags.length} 个标签 · ${matchedUserCount} 人`}</span>
    </span>
  );
}

ScopeStatus.propTypes = {
  tags: PropTypes.arrayOf(PropTypes.string).isRequired,
  matchedUserCount: PropTypes.number.isRequired,
};

export default function UsageScopeManager({ apiKeys, onSaved, compact = false }) {
  const settings = useSettingsStore((state) => state.settings);
  const fetchSettings = useSettingsStore((state) => state.fetchSettings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  const [open, setOpen] = useState(false);
  const [draftTags, setDraftTags] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const scopeTags = normalizeAccessTags(settings?.usageDashboardScopeTags);
  const tagOptions = useMemo(() => {
    const tags = new Set();
    for (const apiKey of apiKeys) {
      for (const tag of normalizeAccessTags(apiKey.accessTags)) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right, "zh-CN"));
  }, [apiKeys]);
  const matchedUserCount = useMemo(
    () => scopeTags.length === 0
      ? apiKeys.length
      : apiKeys.filter((apiKey) => hasAccessTagOverlap(apiKey.accessTags, scopeTags)).length,
    [apiKeys, scopeTags],
  );

  const openManager = async () => {
    setError("");
    const latest = await fetchSettings();
    setDraftTags(normalizeAccessTags(latest?.usageDashboardScopeTags || settings?.usageDashboardScopeTags));
    setOpen(true);
  };

  const toggleTag = (tag) => {
    setDraftTags((current) => current.includes(tag)
      ? current.filter((item) => item !== tag)
      : [...current, tag]);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    const updated = await patchSettings({ usageDashboardScopeTags: draftTags });
    setSaving(false);
    if (!updated) {
      setError("保存失败，请稍后重试。");
      return;
    }
    setOpen(false);
    onSaved?.(updated);
  };

  useEffect(() => {
    if (settings) return;
    fetchSettings().catch(() => {});
  }, [fetchSettings, settings]);

  return (
    <>
      <button
        type="button"
        onClick={openManager}
        title={`统计范围设置：${scopeTags.length === 0 ? "全部使用人" : `${scopeTags.length} 个标签 · ${matchedUserCount} 人`}`}
        aria-label="统计范围设置"
        className={`group inline-flex h-9 items-center rounded-lg border border-border bg-surface text-sm font-semibold text-text-main transition-all hover:border-primary/45 hover:bg-primary/[0.06] hover:text-primary ${compact ? "w-9 justify-center px-0" : "gap-2 px-3"}`}
      >
        <span className="material-symbols-outlined text-[17px] text-text-muted transition-colors group-hover:text-primary">settings</span>
        {!compact ? "统计范围设置" : null}
      </button>

      <Modal
        isOpen={open}
        onClose={() => !saving && setOpen(false)}
        title="维护统计范围"
        size="lg"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>取消</Button>
            <Button variant="primary" onClick={save} loading={saving}>保存范围</Button>
          </>
        )}
      >
        <div className="space-y-5">
          <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined mt-0.5 text-[20px] text-primary">analytics</span>
              <div>
                <p className="text-sm font-semibold text-text-main">默认统计所有使用人</p>
                <p className="mt-1 text-sm leading-6 text-text-muted">选择标签后，使用看板只统计命中任一已选标签的 API Key 使用人；未选择标签时不做范围限制。</p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-text-main">使用人标签</h3>
              <p className="mt-1 text-xs text-text-muted">多选标签按“命中任一标签”计算。</p>
            </div>
            {draftTags.length > 0 ? (
              <button type="button" onClick={() => setDraftTags([])} className="text-xs font-semibold text-primary hover:underline">恢复统计全部</button>
            ) : null}
          </div>

          {tagOptions.length > 0 ? (
            <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 custom-scrollbar">
              {tagOptions.map((tag) => {
                const selected = draftTags.includes(tag);
                const userCount = apiKeys.filter((apiKey) => normalizeAccessTags(apiKey.accessTags).includes(tag)).length;
                return (
                  <label key={tag} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${selected ? "border-primary/50 bg-primary/[0.08]" : "border-border bg-bg/30 hover:border-primary/30"}`}>
                    <input type="checkbox" checked={selected} onChange={() => toggleTag(tag)} className="size-4 accent-[var(--color-primary)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm font-semibold text-text-main">{tag}</span>
                      <span className="mt-0.5 block text-[11px] text-text-muted">{userCount} 位使用人</span>
                    </span>
                    {selected ? <span className="material-symbols-outlined text-[18px] text-primary">check_circle</span> : null}
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-bg/30 px-4 py-8 text-center">
              <span className="material-symbols-outlined text-[28px] text-text-muted">sell</span>
              <p className="mt-2 text-sm font-medium text-text-main">暂无可用标签</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">请先在“集成与凭据”中为 API Key 设置标签。</p>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-border bg-bg/35 px-3 py-2.5">
            <span className="text-xs text-text-muted">保存后，当前看板会立即按新范围刷新。</span>
            <ScopeStatus tags={draftTags} matchedUserCount={draftTags.length === 0 ? apiKeys.length : apiKeys.filter((apiKey) => hasAccessTagOverlap(apiKey.accessTags, draftTags)).length} />
          </div>
          {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
        </div>
      </Modal>
    </>
  );
}

UsageScopeManager.propTypes = {
  apiKeys: PropTypes.arrayOf(PropTypes.object).isRequired,
  onSaved: PropTypes.func,
  compact: PropTypes.bool,
};
