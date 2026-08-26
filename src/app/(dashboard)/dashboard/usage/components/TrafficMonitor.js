"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { formatBytes } from "@/shared/utils/formatBytes";

const fmt = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function statusTone(statusCode, aborted) {
  if (aborted) return "bg-amber-500";
  if (statusCode >= 500) return "bg-rose-500";
  if (statusCode >= 400) return "bg-orange-500";
  return "bg-emerald-500";
}

function SummaryCard({ label, icon, value }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface px-4 py-3 shadow-[var(--shadow-soft)]">
      <div aria-hidden="true" className="absolute -right-6 -top-8 size-20 rounded-full bg-cyan-500/10 blur-2xl" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted">{label}</p>
          <p className="mt-1.5 truncate text-xl font-bold tracking-tight text-text-main">{formatBytes(value.totalBytes)}</p>
        </div>
        <span className="material-symbols-outlined grid size-8 shrink-0 place-items-center rounded-lg bg-cyan-500/10 text-[18px] text-cyan-600">{icon}</span>
      </div>
      <div className="relative mt-2 flex items-center justify-between gap-2 text-[10px] text-text-muted">
        <span>↑ {formatBytes(value.requestBytes)}</span>
        <span>↓ {formatBytes(value.responseBytes)}</span>
        <span>{fmt(value.requests)} 次</span>
      </div>
    </div>
  );
}

SummaryCard.propTypes = {
  label: PropTypes.string.isRequired,
  icon: PropTypes.string.isRequired,
  value: PropTypes.shape({
    requests: PropTypes.number,
    requestBytes: PropTypes.number,
    responseBytes: PropTypes.number,
    totalBytes: PropTypes.number,
  }).isRequired,
};

export default function TrafficMonitor({ stats }) {
  const summary = stats.trafficSummary || {};
  const empty = { requests: 0, requestBytes: 0, responseBytes: 0, totalBytes: 0 };
  const recent = summary.recent || [];

  return (
    <Card className="overflow-hidden" padding="none">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[19px] text-cyan-600">network_check</span>
            <h2 className="text-sm font-semibold text-text-main">网络流量监控</h2>
          </div>
          <p className="mt-1 text-[11px] text-text-muted">应用层请求体与响应体字节，不含 HTTP/TLS 协议头。</p>
        </div>
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.07] px-3 py-1.5 text-right">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-700">当前筛选</p>
          <p className="text-sm font-bold text-text-main">{formatBytes(stats.totalTrafficBytes)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 bg-bg-subtle/25 p-3 sm:grid-cols-3 sm:p-4">
        <SummaryCard label="今日流量" icon="today" value={summary.today || empty} />
        <SummaryCard label="本周流量" icon="date_range" value={summary.week || empty} />
        <SummaryCard label="本月流量" icon="calendar_month" value={summary.month || empty} />
      </div>

      <div className="border-t border-border">
        <div className="flex items-center justify-between px-4 py-2.5 sm:px-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">最近请求流量</p>
          <span className="text-[10px] text-text-muted">↑ 上传 · ↓ 下载</span>
        </div>
        {!recent.length ? (
          <div className="px-5 pb-5 pt-2 text-sm text-text-muted">暂无已完成的 API 请求。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="border-y border-border/70 bg-bg-subtle/50 text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted">
                <tr>
                  <th className="px-4 py-2 text-left sm:px-5">时间</th>
                  <th className="px-4 py-2 text-left">端点</th>
                  <th className="px-4 py-2 text-left">状态</th>
                  <th className="px-4 py-2 text-right">上传</th>
                  <th className="px-4 py-2 text-right">下载</th>
                  <th className="px-4 py-2 text-right sm:pr-5">总流量</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/55">
                {recent.slice(0, 8).map((item) => (
                  <tr key={item.requestId} className="transition-colors hover:bg-cyan-500/[0.025]">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-text-muted sm:px-5">{formatTime(item.timestamp)}</td>
                    <td className="max-w-[340px] px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] font-bold text-text-muted">{item.method}</span>
                        <span className="truncate font-mono text-[11px] text-text-main" title={item.endpoint}>{item.endpoint}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-[10px] text-text-muted">
                        <span className={`size-1.5 rounded-full ${statusTone(item.statusCode, item.aborted)}`} />
                        {item.aborted ? "中断" : item.statusCode || "—"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-indigo-600">{formatBytes(item.requestBytes)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-emerald-600">{formatBytes(item.responseBytes)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold text-text-main sm:pr-5">{formatBytes(item.totalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

TrafficMonitor.propTypes = { stats: PropTypes.object.isRequired };
