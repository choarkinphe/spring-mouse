"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";
import { Skeleton } from "@/shared/components/Loading";
import { formatBytes } from "@/shared/utils/formatBytes";

const METRICS = {
  tokens: { label: "Token", color: "#6366f1", yAxisId: "tokens", format: (value) => fmtTokens(value) },
  cost: { label: "成本", color: "#f59e0b", yAxisId: "cost", format: (value) => fmtCost(value) },
  requests: { label: "模型调用", color: "#10b981", yAxisId: "requests", format: (value) => new Intl.NumberFormat("zh-CN").format(value || 0) },
  trafficBytes: { label: "流量", color: "#0891b2", yAxisId: "traffic", format: (value) => formatBytes(value) },
};

const fmtTokens = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

function UsageChartSkeleton() {
  return (
    <div className="relative h-[392px] overflow-hidden rounded-lg border border-border/70 bg-bg-subtle/30 px-4 pb-8 pt-5" aria-busy="true" aria-label="正在加载使用趋势">
      <div aria-hidden="true" className="absolute inset-x-4 top-12 bottom-8 grid grid-rows-4 border-y border-border/50">
        <span className="border-b border-border/35" />
        <span className="border-b border-border/35" />
        <span className="border-b border-border/35" />
      </div>
      <div className="relative flex h-full flex-col justify-between">
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <span className="material-symbols-outlined animate-spin text-[15px] text-primary">progress_activity</span>
          正在拉取趋势序列
        </div>
        <div className="flex items-end gap-2 px-2">
          {[36, 58, 44, 76, 52, 84, 64, 92, 70, 54, 80, 66].map((height, index) => (
            <Skeleton key={index} className="min-w-0 flex-1 rounded-b-sm rounded-t-md bg-primary/15" style={{ height: `${height}%` }} />
          ))}
        </div>
        <div className="flex justify-between gap-3">
          <Skeleton className="h-2 w-12" />
          <Skeleton className="h-2 w-12" />
          <Skeleton className="h-2 w-12" />
          <Skeleton className="h-2 w-12" />
        </div>
      </div>
    </div>
  );
}

export default function UsageChart({ timeRange, apiKeyId, refreshToken = null, title = "使用趋势", className = "" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedMetrics, setSelectedMetrics] = useState(["tokens", "trafficBytes", "requests"]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      // Keep the previous chart visible during live refreshes; only the first
      // load uses the loading state. Recharts then swaps in the new series.
      async function fetchData() {
        try {
          const params = new URLSearchParams({ period: "today" });
          if (timeRange?.startDate) params.set("startDate", timeRange.startDate);
          if (timeRange?.endDate) params.set("endDate", timeRange.endDate);
          if (apiKeyId) params.set("apiKeyId", apiKeyId);
          const res = await fetch(`/api/usage/chart?${params.toString()}`, { cache: "no-store" });
          if (res.ok && !cancelled) setData(await res.json());
        } catch (error) {
          console.error("Failed to fetch chart data:", error);
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      fetchData();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiKeyId, refreshToken, timeRange?.endDate, timeRange?.startDate]);

  const toggleMetric = (metric) => {
    setSelectedMetrics((previous) => {
      if (previous.includes(metric)) return previous.length === 1 ? previous : previous.filter((item) => item !== metric);
      return [...previous, metric];
    });
  };

  const hasData = data.some((item) => item.tokens > 0 || item.cost > 0 || item.requests > 0 || item.trafficBytes > 0);

  return (
    <Card className={`flex min-w-0 flex-col gap-3 p-3 sm:p-4 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">GROWTH & CONSUMPTION</p>
          <h2 className="mt-1 text-base font-semibold text-text-main">{title}</h2>
          <p className="mt-1 text-[11px] text-text-muted">多指标按各自刻度叠加；悬停可查看精确值。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1 rounded-lg border border-border bg-bg-subtle p-1">
          {Object.entries(METRICS).map(([key, metric]) => {
            const active = selectedMetrics.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleMetric(key)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${active ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text-main"}`}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: active ? metric.color : "currentColor" }} />
                {metric.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <UsageChartSkeleton />
      ) : !hasData ? (
        <div className="flex h-[392px] items-center justify-center text-sm text-text-muted">No data for this period</div>
      ) : (
        <ResponsiveContainer width="100%" height={392}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="tokens"
              hide={!selectedMetrics.includes("tokens")}
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtTokens}
              width={50}
            />
            <YAxis yAxisId="cost" hide />
            <YAxis yAxisId="requests" hide />
            <YAxis yAxisId="traffic" hide />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, _name, item) => {
                const metric = METRICS[item?.dataKey] || METRICS.tokens;
                return [metric.format(value), metric.label];
              }}
            />
            {selectedMetrics.includes("tokens") ? (
              <Area
                yAxisId="tokens"
                name="Token"
                type="monotone"
                dataKey="tokens"
                stroke={METRICS.tokens.color}
                strokeWidth={2.25}
                fill="url(#gradTokens)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : null}
            {selectedMetrics.includes("cost") ? (
              <Line
                yAxisId="cost"
                name="成本"
                type="monotone"
                dataKey="cost"
                stroke={METRICS.cost.color}
                strokeWidth={2.25}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : null}
            {selectedMetrics.includes("trafficBytes") ? (
              <Line
                yAxisId="traffic"
                name="流量"
                type="monotone"
                dataKey="trafficBytes"
                stroke={METRICS.trafficBytes.color}
                strokeWidth={2.25}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : null}
            {selectedMetrics.includes("requests") ? (
              <Line
                yAxisId="requests"
                name="模型调用次数"
                type="monotone"
                dataKey="requests"
                stroke={METRICS.requests.color}
                strokeWidth={2.25}
                strokeDasharray="5 3"
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  timeRange: PropTypes.shape({ startDate: PropTypes.string, endDate: PropTypes.string }),
  apiKeyId: PropTypes.string,
  refreshToken: PropTypes.number,
  title: PropTypes.string,
  className: PropTypes.string,
};
