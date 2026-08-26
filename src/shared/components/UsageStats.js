"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Card from "./Card";
import { ModuleSkeleton, Skeleton } from "./Loading";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";
import UsageChart from "@/app/(dashboard)/dashboard/usage/components/UsageChart";
import ChannelQuotaPanel from "@/app/(dashboard)/dashboard/usage/components/ChannelQuotaPanel";
import UsageBreakdownGrid from "@/app/(dashboard)/dashboard/usage/components/UsageBreakdownGrid";

// Lazy-load: keeps @xyflow/react out of the shared bundle until topology renders.
const ProviderTopology = dynamic(
  () => import("@/app/(dashboard)/dashboard/usage/components/ProviderTopology"),
  {
    ssr: false,
    loading: () => <ModuleSkeleton title="正在初始化请求拓扑" icon="account_tree" lines={4} className="min-h-[320px] xl:h-full" />,
  },
);

const fmt = (n) => new Intl.NumberFormat().format(n || 0);

function timeAgo(timestamp) {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return "—";
  const diff = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function TimeAgo({ timestamp }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return <>{timeAgo(timestamp)}</>;
}

function UsageMetricSkeletons() {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4" aria-label="正在加载概览指标">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-xl border border-border bg-surface/70 p-4 shadow-[var(--shadow-soft)]">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-3 w-20" />
            <span className="size-2 rounded-full bg-primary/35" />
          </div>
          <Skeleton className="mt-4 h-7 w-16" />
          <Skeleton className="mt-3 h-2.5 w-4/5" />
        </div>
      ))}
    </div>
  );
}

function UsageDashboardSkeleton({ showOverview, showBreakdowns }) {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-live="polite">
      {showOverview && (
        <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 xl:h-[min(58rem,calc(100vh-8rem))] xl:grid-cols-[minmax(0,1fr)_minmax(360px,400px)]">
          <div className="flex min-w-0 flex-col gap-2 xl:h-full xl:min-h-0">
            <UsageMetricSkeletons />
            <ModuleSkeleton title="正在汇总实时调用" icon="account_tree" lines={5} className="min-h-[320px] xl:min-h-0 xl:flex-1" />
          </div>
          <div className="flex min-w-0 flex-col gap-2 xl:h-full xl:min-h-0">
            <ModuleSkeleton title="正在读取渠道余量" icon="account_balance_wallet" lines={4} className="min-h-[230px] xl:min-h-0 xl:flex-1" />
            <ModuleSkeleton title="正在读取最近请求" icon="receipt_long" lines={5} className="min-h-[240px]" />
          </div>
        </div>
      )}
      <ModuleSkeleton title="正在生成使用趋势" icon="monitoring" lines={6} className="min-h-[440px]" />
      {showBreakdowns && (
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
          <ModuleSkeleton title="正在拆分渠道与模型数据" icon="data_usage" lines={6} className="min-h-[300px]" />
          <ModuleSkeleton title="正在整理调用明细" icon="receipt_long" lines={6} className="min-h-[300px]" />
        </div>
      )}
    </div>
  );
}

function RecentRequests({ requests = [], className = "" }) {
  return (
    <Card className={`flex min-h-[300px] min-w-0 flex-1 flex-col overflow-hidden ${className}`} padding="sm">
      <div className="shrink-0 border-b border-border px-1 py-2">
        <span className="text-xs font-semibold tracking-wide text-text-muted">最近的请求</span>
      </div>

      {!requests.length ? (
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">暂时没有请求。</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full min-w-[340px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-bg">
              <tr className="border-b border-border">
                <th className="w-2 py-1.5 text-left font-semibold text-text-muted" />
                <th className="py-1.5 text-left font-semibold text-text-muted">模型</th>
                <th className="w-[72px] py-1.5 text-left font-semibold text-text-muted">使用人</th>
                <th className="py-1.5 text-right font-semibold whitespace-nowrap text-text-muted">输入/输出</th>
                <th className="py-1.5 text-right font-semibold text-text-muted">时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {requests.map((request, index) => {
                const succeeded = !request.status || request.status === "ok" || request.status === "success";
                return (
                  <tr key={index} className="transition-colors hover:bg-bg-subtle">
                    <td className="py-1.5">
                      <span className={`block h-1.5 w-1.5 rounded-full ${succeeded ? "bg-success" : "bg-error"}`} />
                    </td>
                    <td className="max-w-[104px] truncate py-1.5 font-mono" title={request.model}>{request.model}</td>
                    <td className="max-w-[72px] truncate py-1.5 text-text-muted" title={request.userName}>{request.userName || "未标记"}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <span className="text-primary">{fmt(request.promptTokens)}↑</span>{" "}
                      <span className="text-success">{fmt(request.completionTokens)}↓</span>
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap text-text-muted">
                      <TimeAgo timestamp={request.timestamp} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function UsageStats({ timeRange, apiKeyId, showOverview = true, showBreakdowns = false } = {}) {
  const [stats, setStats] = useState(null);
  const [chartRefreshToken, setChartRefreshToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const isInitialLoad = useRef(true);
  const hasLoadedStats = useRef(false);

  useEffect(() => {
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      setLoading(true);
    }

    const params = new URLSearchParams({ period: "today" });
    if (timeRange?.startDate) params.set("startDate", timeRange.startDate);
    if (timeRange?.endDate) params.set("endDate", timeRange.endDate);
    if (apiKeyId) params.set("apiKeyId", apiKeyId);

    fetch(`/api/usage/stats?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) {
          hasLoadedStats.current = true;
          setStats((previous) => ({ ...previous, ...data }));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [apiKeyId, timeRange?.endDate, timeRange?.startDate]);

  // SSE uses the same period/date/key filters as the initial stats request.
  // Full refreshes update aggregate cards; pending refreshes update live fields.
  useEffect(() => {
    const params = new URLSearchParams({ period: "today" });
    if (timeRange?.startDate) params.set("startDate", timeRange.startDate);
    if (timeRange?.endDate) params.set("endDate", timeRange.endDate);
    if (apiKeyId) params.set("apiKeyId", apiKeyId);
    const eventSource = new EventSource(`/api/usage/stream?${params.toString()}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setStats(data);
        if (data.streamUpdatedAt) {
          setChartRefreshToken((previous) => (data.streamUpdatedAt > previous ? data.streamUpdatedAt : previous));
        }
        if (hasLoadedStats.current) setLoading(false);
      } catch (error) {
        console.error("[SSE CLIENT] parse error:", error);
      }
    };

    eventSource.onerror = () => setLoading(false);
    return () => eventSource.close();
  }, [apiKeyId, timeRange?.endDate, timeRange?.startDate]);

  if (!stats && !loading) return <div className="text-text-muted">Failed to load usage statistics.</div>;

  if (!stats) return <UsageDashboardSkeleton showOverview={showOverview} showBreakdowns={showBreakdowns} />;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {showOverview && (
        <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 xl:h-[min(58rem,calc(100vh-8rem))] xl:grid-cols-[minmax(0,1fr)_minmax(360px,400px)]">
          <div className="flex min-w-0 flex-col gap-2 xl:h-full xl:min-h-0">
            <OverviewCards stats={stats} />
            <ProviderTopology
              activeRequests={stats.activeRequests || []}
              className="xl:h-auto xl:min-h-0 xl:flex-1"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 xl:h-full xl:min-h-0">
            <ChannelQuotaPanel />
            <RecentRequests requests={stats.recentRequests || []} className="min-h-[240px] xl:min-h-[16rem]" />
          </div>
        </div>
      )}

      {showOverview && <UsageChart timeRange={timeRange} apiKeyId={apiKeyId} refreshToken={chartRefreshToken} />}
      {showBreakdowns && <UsageBreakdownGrid stats={stats} timeRange={timeRange} apiKeyId={apiKeyId} chartRefreshToken={chartRefreshToken} />}
    </div>
  );
}
