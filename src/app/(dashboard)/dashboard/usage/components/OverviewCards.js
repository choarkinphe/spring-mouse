"use client";

import PropTypes from "prop-types";
import StatCard from "@/shared/components/StatCard";
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

export default function OverviewCards({ stats, loading = false }) {
  // Same total the rest of the dashboard uses (UsageBreakdownGrid, the person
  // report): input + output. Cached tokens are deliberately NOT added in — they
  // are a subset of the input tokens, so counting them again would double-bill
  // the same work and inflate the headline number.
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  // Per-bucket series for the trailing sparklines — same live window the usage
  // board charts, so both pages read from one source.
  const recent = Array.isArray(stats.last10Minutes) ? stats.last10Minutes : [];
  const series = (field) => recent.map((item) => item[field] || 0);

  // Four cards instead of six: the three single-value token cards each wasted a
  // whole card on one number, and at the real content width the row kept
  // alternating between cramped and half-empty. Merging them frees the width to
  // give the token card — the only one carrying three sub-metrics — a wider
  // track, so the reading order is token → 调用 → 流量 → 成本.
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 sm:gap-4 2xl:grid-cols-[1.4fr_1fr_1fr_1fr]">
      <StatCard
        icon="toll"
        eyebrow="TOKENS"
        value={fmtCompact(totalTokens)}
        valueTitle={`输入 ${fmt(stats.totalPromptTokens)} + 输出 ${fmt(stats.totalCompletionTokens)} = ${fmt(totalTokens)}`}
        tone="primary"
        points={series("promptTokens")}
        loading={loading}
        // Input / output / cached, in that order. Colours match each metric's
        // accent elsewhere on the page: input=primary, output=success,
        // cached=info (cached is shown but not summed into the headline).
        metrics={[
          { label: "输入", value: fmtCompact(stats.totalPromptTokens), tone: "primary", title: `输入 ${fmt(stats.totalPromptTokens)}` },
          { label: "输出", value: fmtCompact(stats.totalCompletionTokens), tone: "success", title: `输出 ${fmt(stats.totalCompletionTokens)}` },
          { label: "缓存", value: fmtCompact(stats.totalCachedTokens), tone: "info", title: `缓存命中 ${fmt(stats.totalCachedTokens)}（已含在输入内）` },
        ]}
      />
      <StatCard
        icon="send"
        eyebrow="REQUESTS"
        value={fmtCompact(stats.totalRequests)}
        valueTitle={`模型调用次数 ${fmt(stats.totalRequests)}`}
        tone="sky"
        points={series("requests")}
        loading={loading}
        metrics={[
          { label: "已完成", value: fmtCompact(stats.completedRequests), tone: "success", title: `${fmtCompact(stats.completedRequests)} 已完成` },
          { label: "失败", value: fmtCompact(stats.failedRequests), tone: "danger", title: `${fmtCompact(stats.failedRequests)} 失败` },
          { label: "已取消", value: fmtCompact(stats.cancelledRequests), tone: "muted", title: `${fmtCompact(stats.cancelledRequests)} 已取消` },
        ]}
      />
      <StatCard
        icon="network_check"
        eyebrow="TRAFFIC"
        value={formatBytes(stats.totalTrafficBytes)}
        valueTitle={`总流量 ${formatBytes(stats.totalTrafficBytes, { maximumFractionDigits: 2 })}`}
        tone="cyan"
        points={series("trafficBytes")}
        loading={loading}
        // Up/down split rendered as the same "mini panel" the request card uses
        // (rounded-md + hairline border + tiny caption), instead of the old
        // single line of 10px text. Two cells because there are only two
        // directions; the dominant one (down) keeps the card's cyan accent.
        metrics={[
          { label: "↑ 上行", value: formatBytes(stats.totalRequestBytes), tone: "sky", title: `上行 ${formatBytes(stats.totalRequestBytes, { maximumFractionDigits: 2 })}` },
          { label: "↓ 下行", value: formatBytes(stats.totalResponseBytes), tone: "cyan", title: `下行 ${formatBytes(stats.totalResponseBytes, { maximumFractionDigits: 2 })}` },
        ]}
      />
      <StatCard
        icon="paid"
        eyebrow="COST"
        value={`~${fmtCost(stats.totalCost)}`}
        tone="warning"
        points={series("cost")}
        detail="预估费用，非实际账单"
        loading={loading}
      />
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
  loading: PropTypes.bool,
};
