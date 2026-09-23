"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Card from "./Card";
import { ModuleSkeleton, Skeleton } from "./Loading";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";
import UsageChart from "@/app/(dashboard)/dashboard/usage/components/UsageChart";
import ChannelQuotaPanel from "@/app/(dashboard)/dashboard/usage/components/ChannelQuotaPanel";
import { applyUsageStatsUpdate, normalizeUsageStatsSnapshot } from "@/shared/utils/usageStatsSnapshot";

// Lazy-load: keeps @xyflow/react out of the shared bundle until topology renders.
const ProviderTopology = dynamic(
  () => import("@/app/(dashboard)/dashboard/usage/components/ProviderTopology"),
  {
    ssr: false,
    loading: () => <ModuleSkeleton title="正在初始化请求拓扑" icon="account_tree" lines={4} className="min-h-[320px] xl:h-full" />,
  },
);

const UsageBreakdownGrid = dynamic(
  () => import("@/app/(dashboard)/dashboard/usage/components/UsageBreakdownGrid"),
  {
    ssr: false,
    loading: () => <ModuleSkeleton title="正在装载使用分析面板" icon="analytics" lines={7} className="min-h-[520px]" />,
  },
);

// Lazy: the drawer pulls the full request record (cost, endpoint, IP, traffic)
// and is only opened on demand from the "最近的请求" card.
const UsageDetailsDrawer = dynamic(
  () => import("@/app/(dashboard)/dashboard/usage/components/UsageDetailsDrawer"),
  { ssr: false },
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
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 sm:gap-4 2xl:grid-cols-[1.4fr_1fr_1fr_1fr]" aria-label="正在加载概览指标">
      {[
        { subMetrics: 3, sparkline: true },
        { subMetrics: 3, sparkline: true },
        { subMetrics: 2, sparkline: true },
        { subMetrics: 0, sparkline: true },
      ].map(({ subMetrics, sparkline }, index) => (
        <div key={index} className="relative overflow-hidden rounded-[14px] border border-border-subtle bg-surface px-4 py-3 shadow-[var(--shadow-soft)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-2.5 w-20" />
              </div>
              <Skeleton className="mt-3 h-7 w-24" />
            </div>
            {sparkline && <Skeleton className="h-10 w-24 rounded-md" />}
          </div>
          {subMetrics > 0 && (
            <div className={`mt-2 grid ${subMetrics === 3 ? "grid-cols-3" : "grid-cols-2"} gap-1.5`}>
              {Array.from({ length: subMetrics }, (_, metricIndex) => (
                <div key={metricIndex} className="rounded-md border border-border/70 px-1.5 py-1">
                  <Skeleton className="mx-auto h-3 w-10" />
                  <Skeleton className="mx-auto mt-1 h-2 w-8" />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function UsageDashboardSkeleton({ showOverview, showBreakdowns }) {
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

function RecentRequests({ requests = [], className = "", onViewDetails }) {
  return (
    <Card className={`flex min-h-[300px] min-w-0 flex-1 flex-col overflow-hidden ${className}`} padding="sm">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-1 py-2">
        <span className="text-xs font-semibold tracking-wide text-text-muted">最近的请求</span>
        {/* The card shows the thin live feed (model / user / tokens / time).
            The drawer shows the full record — cost, endpoint, IP, traffic —
            which is what you want when a row looks wrong. */}
        {onViewDetails && (
          <button
            type="button"
            onClick={onViewDetails}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            查看明细
            <span className="material-symbols-outlined text-[14px]">chevron_right</span>
          </button>
        )}
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

export default function UsageStats({ timeRange, apiKeyId, showOverview = true, showBreakdowns = false, scope } = {}) {
  const [stats, setStats] = useState(null);
  const [chartRefreshToken, setChartRefreshToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Options for the details drawer's filters, derived from the loaded stats.
  // The board builds the same shape in UsageBreakdownGrid; this is the subset
  // the home page has data for.
  const detailFilterOptions = useMemo(() => {
    const keys = (map) => Object.keys(map || {}).filter(Boolean);
    const people = Object.entries(stats?.byUser || {}).map(([key, person]) => ({
      id: person?.userId || key,
      label: person?.keyName || person?.apiKeyMasked || key,
    })).filter((item) => item.id);
    const models = Object.entries(stats?.byModel || {}).map(([key, model]) => model?.rawModel || key).filter(Boolean);
    return {
      providers: keys(stats?.byProvider),
      models,
      people,
      apps: Object.entries(stats?.byApp || {}).map(([key, app]) => app?.appName || key).filter(Boolean),
      sourceIps: Object.entries(stats?.bySourceIp || {}).map(([key, ip]) => ip?.sourceIp || key).filter(Boolean),
    };
  }, [stats]);
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
    if (scope) params.set("scope", scope);

    fetch(`/api/usage/stats?${params.toString()}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const normalized = normalizeUsageStatsSnapshot(data, { partial: Boolean(data.streamPatch) });
        if (normalized) {
          hasLoadedStats.current = true;
          setStats((previous) => applyUsageStatsUpdate(previous, normalized));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [apiKeyId, scope, timeRange?.endDate, timeRange?.startDate]);

  // SSE uses the same period/date/key filters as the initial stats request.
  // Full refreshes update aggregate cards; pending refreshes update live fields.
  useEffect(() => {
    const params = new URLSearchParams({ period: "today" });
    if (timeRange?.startDate) params.set("startDate", timeRange.startDate);
    if (timeRange?.endDate) params.set("endDate", timeRange.endDate);
    if (apiKeyId) params.set("apiKeyId", apiKeyId);
    if (scope) params.set("scope", scope);
    const eventSource = new EventSource(`/api/usage/stream?${params.toString()}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const normalized = normalizeUsageStatsSnapshot(data, { partial: Boolean(data.streamPatch) });
        if (!normalized) return;
        if (data.streamPatch) {
          const { streamPatch: _streamPatch, ...patch } = normalized;
          setStats((previous) => applyUsageStatsUpdate(previous, patch, { streamPatch: true }));
        } else {
          setStats((previous) => applyUsageStatsUpdate(previous, normalized));
        }
        if (!data.streamPatch && normalized.streamUpdatedAt) {
          setChartRefreshToken((previous) => (normalized.streamUpdatedAt > previous ? normalized.streamUpdatedAt : previous));
        }
        if (hasLoadedStats.current) setLoading(false);
      } catch (error) {
        console.error("[SSE CLIENT] parse error:", error);
      }
    };

    eventSource.onerror = () => setLoading(false);
    return () => eventSource.close();
  }, [apiKeyId, scope, timeRange?.endDate, timeRange?.startDate]);

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
              recentRequests={stats.recentRequests || []}
              className="xl:h-auto xl:min-h-0 xl:flex-1"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 xl:h-full xl:min-h-0">
            <ChannelQuotaPanel />
            <RecentRequests
              requests={stats.recentRequests || []}
              className="min-h-[240px] xl:min-h-[16rem]"
              onViewDetails={() => setDetailsOpen(true)}
            />
          </div>
        </div>
      )}

      {showOverview && <UsageChart timeRange={timeRange} apiKeyId={apiKeyId} scope={scope} refreshToken={chartRefreshToken} />}
      {showBreakdowns && <UsageBreakdownGrid stats={stats} timeRange={timeRange} apiKeyId={apiKeyId} scope={scope} chartRefreshToken={chartRefreshToken} />}

      {/* Opened from the "最近的请求" card. Scoped to the same window the page is
          showing, so the detail list matches the numbers above it. */}
      {detailsOpen && (
        <UsageDetailsDrawer
          isOpen={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          subject="最近请求明细"
          initialFilters={{
            ...(timeRange?.startDate ? { startDate: timeRange.startDate } : {}),
            ...(timeRange?.endDate ? { endDate: timeRange.endDate } : {}),
            ...(apiKeyId ? { apiKeyId } : {}),
          }}
          filterOptions={detailFilterOptions}
        />
      )}
    </div>
  );
}
