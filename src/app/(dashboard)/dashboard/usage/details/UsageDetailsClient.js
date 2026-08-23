"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Card from "@/shared/components/Card";
import Pagination from "@/shared/components/Pagination";

const FILTER_LABELS = {
  provider: "提供商",
  model: "模型",
  apiKeyId: "使用人",
  appName: "来源应用",
  sourceIp: "来源 IP",
  status: "状态",
};

const fmt = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);
const fmtCost = (value) => `$${Number(value || 0).toFixed(4)}`;

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function formatRange(startDate, endDate) {
  if (!startDate || !endDate) return "全部已记录的使用数据";
  return `${formatDateTime(startDate)} 至 ${formatDateTime(endDate)}`;
}

function formatDuration(durationMs) {
  if (!durationMs) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} 秒`;
  return `${(durationMs / 60_000).toFixed(1)} 分`;
}

function StatusBadge({ status }) {
  const className = status === "error"
    ? "border-rose-500/20 bg-rose-500/10 text-rose-600"
    : status === "cancelled"
      ? "border-amber-500/20 bg-amber-500/10 text-amber-600"
      : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600";
  const label = status === "error" ? "失败" : status === "cancelled" ? "已取消" : "成功";
  return <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${className}`}>{label}</span>;
}

function FilterChip({ label, value, onRemove }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/[0.07] py-1 pl-2.5 pr-1 text-xs text-text-main">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="max-w-[220px] truncate font-semibold" title={value}>{value}</span>
      <button
        type="button"
        onClick={onRemove}
        className="grid size-5 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"
        aria-label={`移除${label}筛选`}
      >
        <span className="material-symbols-outlined text-[15px]">close</span>
      </button>
    </span>
  );
}

export default function UsageDetailsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryKey = searchParams.toString();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState({ details: [], pagination: { totalItems: 0 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const filters = useMemo(() => {
    const values = {};
    for (const key of Object.keys(FILTER_LABELS)) {
      const value = searchParams.get(key);
      if (value) values[key] = value;
    }
    return values;
  }, [searchParams]);
  const startDate = searchParams.get("startDate") || "";
  const endDate = searchParams.get("endDate") || "";
  const subject = searchParams.get("subject") || "当前统计项";

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams(queryKey);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const response = await fetch(`/api/usage/details?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("请求明细加载失败");
      setData(await response.json());
    } catch (loadError) {
      setError(loadError.message || "请求明细加载失败");
      setData({ details: [], pagination: { totalItems: 0 } });
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, queryKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => { loadDetails(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDetails]);

  const removeFilter = (key) => {
    const params = new URLSearchParams(queryKey);
    params.delete(key);
    params.delete("subject");
    setPage(1);
    router.replace(`/dashboard/usage/details${params.size ? `?${params.toString()}` : ""}`);
  };

  const clearFilters = () => {
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    setPage(1);
    router.replace(`/dashboard/usage/details${params.size ? `?${params.toString()}` : ""}`);
  };
  const pagination = data.pagination || { totalItems: 0 };
  const filterDisplayValues = { ...filters };
  if (filterDisplayValues.apiKeyId && subject.startsWith("使用人：")) {
    filterDisplayValues.apiKeyId = subject.slice("使用人：".length);
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <header className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-border bg-surface/80 px-5 py-4 shadow-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="grid size-10 place-items-center rounded-xl border border-primary/25 bg-primary/[0.09] text-primary">
              <span className="material-symbols-outlined text-[21px]">receipt_long</span>
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">USAGE DRILL-DOWN</p>
              <h1 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-text-main">{subject} · 使用明细</h1>
            </div>
          </div>
          <p className="mt-3 text-sm text-text-muted">{formatRange(startDate, endDate)}，按调用时间从新到旧排列。</p>
        </div>
        <Link href="/dashboard/usage" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-text-main transition-colors hover:border-primary/35 hover:bg-primary/[0.05] hover:text-primary">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          返回使用看板
        </Link>
      </header>

      <Card className="overflow-hidden" padding="sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-1 pb-3">
          <div>
            <p className="text-sm font-semibold text-text-main">已继承统计筛选</p>
            <p className="mt-0.5 text-xs text-text-muted">移除条件可逐层扩大查看范围。</p>
          </div>
          {Object.keys(filters).length > 0 && (
            <button type="button" onClick={clearFilters} className="text-xs font-semibold text-primary hover:underline">清除全部条件</button>
          )}
        </div>
        <div className="flex flex-wrap gap-2 px-1 pt-3">
          {Object.entries(filterDisplayValues).map(([key, value]) => (
            <FilterChip key={key} label={FILTER_LABELS[key]} value={value} onRemove={() => removeFilter(key)} />
          ))}
          {!Object.keys(filters).length && <span className="text-xs text-text-muted">未指定单项筛选，正在展示该时间范围内的全部调用。</span>}
        </div>
      </Card>

      <Card className="min-w-0 overflow-hidden" padding="none">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-text-main">调用记录</h2>
            <p className="mt-0.5 text-xs text-text-muted">使用历史是看板统计的同一数据源，包含完成、失败与取消的调用。</p>
          </div>
          <span className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">{fmt(pagination.totalItems)} 条</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] border-collapse text-xs">
            <thead className="border-b border-border bg-bg-subtle/50 text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted">
              <tr>
                <th className="px-4 py-3 text-left">调用时间</th>
                <th className="px-4 py-3 text-left">使用人</th>
                <th className="px-4 py-3 text-left">模型 / 提供商</th>
                <th className="px-4 py-3 text-left">来源</th>
                <th className="px-4 py-3 text-left">请求端点</th>
                <th className="px-4 py-3 text-left">状态</th>
                <th className="px-4 py-3 text-right">输入 / 输出</th>
                <th className="px-4 py-3 text-right">总 Token</th>
                <th className="px-4 py-3 text-right">成本</th>
                <th className="px-4 py-3 text-right">耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {loading ? (
                <tr><td colSpan="10" className="px-5 py-14 text-center text-sm text-text-muted"><span className="material-symbols-outlined mr-2 animate-spin align-[-4px] text-[18px]">progress_activity</span>正在读取调用明细…</td></tr>
              ) : error ? (
                <tr><td colSpan="10" className="px-5 py-14 text-center text-sm text-rose-600">{error}</td></tr>
              ) : !data.details?.length ? (
                <tr><td colSpan="10" className="px-5 py-14 text-center text-sm text-text-muted">当前筛选范围内没有调用记录。</td></tr>
              ) : data.details.map((detail) => (
                <tr key={detail.id} className="transition-colors hover:bg-primary/[0.025]">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-text-muted">{formatDateTime(detail.timestamp)}</td>
                  <td className="max-w-[160px] px-4 py-3"><p className="truncate font-semibold text-text-main" title={detail.keyName}>{detail.keyName}</p></td>
                  <td className="max-w-[240px] px-4 py-3"><p className="truncate font-semibold text-text-main" title={detail.model}>{detail.model}</p><p className="mt-0.5 truncate text-[10px] text-text-muted" title={detail.provider}>{detail.provider}</p></td>
                  <td className="max-w-[220px] px-4 py-3"><p className="truncate font-medium text-text-main" title={detail.appName}>{detail.appName}</p><p className="mt-0.5 truncate font-mono text-[10px] text-text-muted" title={detail.sourceIp || "IP 未采集"}>{detail.sourceIp || "IP 未采集"}</p></td>
                  <td className="max-w-[220px] px-4 py-3 font-mono text-[11px] text-text-muted"><p className="truncate" title={detail.endpoint}>{detail.endpoint || "—"}</p></td>
                  <td className="px-4 py-3"><StatusBadge status={detail.status} /></td>
                  <td className="whitespace-nowrap px-4 py-3 text-right"><span className="text-indigo-500">{fmt(detail.promptTokens)}</span><span className="px-1 text-text-muted">/</span><span className="text-emerald-500">{fmt(detail.completionTokens)}</span></td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-primary">{fmt(detail.totalTokens)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-warning">{fmtCost(detail.cost)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-text-muted">{formatDuration(detail.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && !error && pagination.totalItems > 0 && (
          <div className="border-t border-border px-3">
            <Pagination
              currentPage={page}
              pageSize={pageSize}
              totalItems={pagination.totalItems}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => { setPageSize(nextPageSize); setPage(1); }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
