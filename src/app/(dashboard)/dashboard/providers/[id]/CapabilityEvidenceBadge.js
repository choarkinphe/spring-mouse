"use client";

export default function CapabilityEvidenceBadge({ profiles, onClick }) {
  if (!profiles?.length) return null;
  const current = profiles.filter((profile) => !profile.stale);
  const lowerBound = Math.max(0, ...current.map((profile) => profile.currentEvidence?.contextWindow?.context?.verifiedRetrievalTokens || 0));
  return <button type="button" onClick={onClick} className="mt-2 flex max-w-full items-center gap-1 truncate text-[10px] text-primary" title="查看按账号保存的实测证据">
    <span className="material-symbols-outlined text-[13px]">fact_check</span>
    {current.length ? "部分能力已实测" : "实测档案 · 已过期/待确认"}{lowerBound > 0 ? ` · 检索 ≥ ${(lowerBound / 1000).toFixed(1)}K` : ""}
  </button>;
}
