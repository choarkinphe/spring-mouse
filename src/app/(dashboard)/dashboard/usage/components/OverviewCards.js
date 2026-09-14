"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { formatBytes } from "@/shared/utils/formatBytes";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
// Counts below 1000 print as-is (no unit); from 1000 up they get K/M/B/T.
const UNITS = [
  [1_000_000_000_000, "T"],
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "K"],
];
const roundCompact = (v) => Number(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2));
const fmtCompact = (n) => {
  const value = Number(n) || 0;
  if (Math.abs(value) < 1_000) return fmt(value);
  let index = UNITS.findIndex(([threshold]) => Math.abs(value) >= threshold);
  let compact = roundCompact(value / UNITS[index][0]);
  // Rounding can push a value past its own unit's ceiling (999,999,999 →
  // "1000M"), which both reads wrong and is 5 characters — the widest thing the
  // narrow mini panels can hold. On that boundary, step up a tier instead.
  if (Math.abs(compact) >= 1_000 && index > 0) {
    index -= 1;
    compact = roundCompact(value / UNITS[index][0]);
  }
  return `${compact}${UNITS[index][1]}`;
};
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats }) {
  // Same total the rest of the dashboard uses (UsageBreakdownGrid, the person
  // report): input + output. Cached tokens are deliberately NOT added in — they
  // are a subset of the input tokens, so counting them again would double-bill
  // the same work and inflate the headline number.
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  // Four cards instead of six: the three single-value token cards each wasted a
  // whole card on one number, and at the real content width the row kept
  // alternating between cramped and half-empty. Merging them frees the width to
  // give the token card — the only one carrying three sub-metrics — a wider
  // track, so the reading order is token → 调用 → 流量 → 成本.
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 sm:gap-4 2xl:grid-cols-[1.4fr_1fr_1fr_1fr]">
      <Card className="flex min-w-0 flex-col gap-1 border-primary/20 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">Token 统计</span>
        <span
          className="truncate text-2xl font-bold text-primary"
          title={`输入 ${fmt(stats.totalPromptTokens)} + 输出 ${fmt(stats.totalCompletionTokens)} = ${fmt(totalTokens)}`}
        >
          {fmtCompact(totalTokens)}
        </span>
        {/* Input / output / cached, in that order. Colours match each metric's
            accent elsewhere on the page: input=primary, output=success,
            cached=info (cached is shown but not summed into the headline). */}
        <div className="mt-1 grid grid-cols-3 gap-1.5" aria-label="Token 构成">
          <div className="min-w-0 rounded-md border border-primary/15 bg-primary/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-primary" title={`输入 ${fmt(stats.totalPromptTokens)}`}>
              {fmtCompact(stats.totalPromptTokens)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">输入</div>
          </div>
          <div className="min-w-0 rounded-md border border-success/15 bg-success/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-success" title={`输出 ${fmt(stats.totalCompletionTokens)}`}>
              {fmtCompact(stats.totalCompletionTokens)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">输出</div>
          </div>
          <div className="min-w-0 rounded-md border border-info/15 bg-info/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-info" title={`缓存命中 ${fmt(stats.totalCachedTokens)}（已含在输入内）`}>
              {fmtCompact(stats.totalCachedTokens)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">缓存</div>
          </div>
        </div>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">模型调用次数</span>
        <span className="truncate text-2xl font-bold">{fmtCompact(stats.totalRequests)}</span>
        <div className="mt-1 grid grid-cols-3 gap-1.5" aria-label="请求状态统计">
          <div className="min-w-0 rounded-md border border-success/15 bg-success/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-success" title={`${fmtCompact(stats.completedRequests)} 已完成`}>
              {fmtCompact(stats.completedRequests)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">已完成</div>
          </div>
          <div className="min-w-0 rounded-md border border-danger/15 bg-danger/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-danger" title={`${fmtCompact(stats.failedRequests)} 失败`}>
              {fmtCompact(stats.failedRequests)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">失败</div>
          </div>
          <div className="min-w-0 rounded-md border border-text-muted/15 bg-text-muted/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-text-secondary" title={`${fmtCompact(stats.cancelledRequests)} 已取消`}>
              {fmtCompact(stats.cancelledRequests)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">已取消</div>
          </div>
        </div>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 border-cyan-500/20 px-4 py-3">
        <span className="text-text-muted text-sm font-semibold">数据流量</span>
        <span className="truncate text-2xl font-bold text-cyan-600" title={`总流量 ${formatBytes(stats.totalTrafficBytes, { maximumFractionDigits: 2 })}`}>
          {formatBytes(stats.totalTrafficBytes)}
        </span>
        {/* Up/down split rendered as the same "mini panel" the request card uses
            (rounded-md + hairline border + tiny caption), instead of the old
            single line of 10px text. Two cells because there are only two
            directions; the dominant one (down) keeps the card's cyan accent. */}
        <div className="mt-1 grid grid-cols-2 gap-1.5" aria-label="流量上下行">
          <div className="min-w-0 rounded-md border border-sky-500/15 bg-sky-500/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-sky-600" title={`上行 ${formatBytes(stats.totalRequestBytes, { maximumFractionDigits: 2 })}`}>
              {formatBytes(stats.totalRequestBytes)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">↑ 上行</div>
          </div>
          <div className="min-w-0 rounded-md border border-cyan-500/15 bg-cyan-500/5 px-1.5 py-1 text-center">
            <div className="truncate text-[11px] font-semibold leading-tight text-cyan-600" title={`下行 ${formatBytes(stats.totalResponseBytes, { maximumFractionDigits: 2 })}`}>
              {formatBytes(stats.totalResponseBytes)}
            </div>
            <div className="mt-0.5 text-[9px] leading-tight text-text-muted">↓ 下行</div>
          </div>
        </div>
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
