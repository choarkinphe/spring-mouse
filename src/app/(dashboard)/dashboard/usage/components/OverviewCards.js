"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { formatBytes } from "@/shared/utils/formatBytes";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtTokenMillions = (n) => `${((Number(n) || 0) / 1_000_000).toFixed(2)}M`;
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">模型调用次数</span>
        <span className="truncate text-2xl font-bold">{fmt(stats.totalRequests)}</span>
        <div className="mt-1 grid grid-cols-3 gap-1.5" aria-label="请求状态统计">
          <div className="min-w-0 rounded-md border border-success/15 bg-success/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-success" title={`${fmt(stats.completedRequests)} 已完成`}>
              {fmt(stats.completedRequests)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">已完成</div>
          </div>
          <div className="min-w-0 rounded-md border border-danger/15 bg-danger/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-danger" title={`${fmt(stats.failedRequests)} 失败`}>
              {fmt(stats.failedRequests)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">失败</div>
          </div>
          <div className="min-w-0 rounded-md border border-text-muted/15 bg-text-muted/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-text-secondary" title={`${fmt(stats.cancelledRequests)} 已取消`}>
              {fmt(stats.cancelledRequests)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">已取消</div>
          </div>
        </div>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 border-cyan-500/20 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">数据流量</span>
        <span className="truncate text-2xl font-bold text-cyan-600">{formatBytes(stats.totalTrafficBytes)}</span>
        <span className="text-[10px] text-text-muted">↑ {formatBytes(stats.totalRequestBytes)} · ↓ {formatBytes(stats.totalResponseBytes)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">输入 Token 总计</span>
        <span className="truncate text-2xl font-bold text-primary" title={fmt(stats.totalPromptTokens)}>{fmtTokenMillions(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">缓存 Token</span>
        <span className="truncate text-2xl font-bold text-info" title={fmt(stats.totalCachedTokens)}>{fmtTokenMillions(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">输出 Token</span>
        <span className="truncate text-2xl font-bold text-success" title={fmt(stats.totalCompletionTokens)}>{fmtTokenMillions(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">预估成本</span>
        <span className="truncate text-2xl font-bold text-warning">~{fmtCost(stats.totalCost)}</span>
        <span className="text-[10px] text-text-muted">预估费用，非实际账单</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
