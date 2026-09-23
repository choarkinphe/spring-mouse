"use client";

import PropTypes from "prop-types";
import Card from "./Card";
import { Skeleton } from "./Loading";
import { cn } from "@/shared/utils/cn";

// One tone table for every accent the usage cards use. Each entry drives the
// whole card consistently: the top hairline strip, the icon chip, the headline
// value, the sparkline stroke, and the mini metric panels. Keeping them together
// is what lets the homepage and the usage board render the same card language
// from one component instead of two drifting copies.
const TONES = {
  primary: { bar: "bg-primary", chip: "bg-primary/10 text-primary", accent: "text-primary", spark: "#3b82f6", panel: "border-primary/15 bg-primary/5", panelText: "text-primary" },
  success: { bar: "bg-success", chip: "bg-success/10 text-success", accent: "text-success", spark: "#10b981", panel: "border-success/15 bg-success/5", panelText: "text-success" },
  info: { bar: "bg-info", chip: "bg-info/10 text-info", accent: "text-info", spark: "#0891b2", panel: "border-info/15 bg-info/5", panelText: "text-info" },
  warning: { bar: "bg-warning", chip: "bg-warning/10 text-warning", accent: "text-warning", spark: "#f59e0b", panel: "border-warning/15 bg-warning/5", panelText: "text-warning" },
  danger: { bar: "bg-danger", chip: "bg-danger/10 text-danger", accent: "text-danger", spark: "#ef4444", panel: "border-danger/15 bg-danger/5", panelText: "text-danger" },
  muted: { bar: "bg-text-muted/40", chip: "bg-text-muted/10 text-text-muted", accent: "text-text-muted", spark: "#94a3b8", panel: "border-text-muted/15 bg-text-muted/5", panelText: "text-text-muted" },
  sky: { bar: "bg-sky-500", chip: "bg-sky-500/10 text-sky-600", accent: "text-sky-600", spark: "#0ea5e9", panel: "border-sky-500/15 bg-sky-500/5", panelText: "text-sky-600" },
  cyan: { bar: "bg-cyan-500", chip: "bg-cyan-500/10 text-cyan-600", accent: "text-cyan-600", spark: "#0891b2", panel: "border-cyan-500/15 bg-cyan-500/5", panelText: "text-cyan-600" },
  indigo: { bar: "bg-indigo-500", chip: "bg-indigo-500/10 text-indigo-600", accent: "text-indigo-600", spark: "#6366f1", panel: "border-indigo-500/15 bg-indigo-500/5", panelText: "text-indigo-600" },
  emerald: { bar: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-600", accent: "text-emerald-600", spark: "#10b981", panel: "border-emerald-500/15 bg-emerald-500/5", panelText: "text-emerald-600" },
  amber: { bar: "bg-amber-500", chip: "bg-amber-500/10 text-amber-600", accent: "text-amber-600", spark: "#f59e0b", panel: "border-amber-500/15 bg-amber-500/5", panelText: "text-amber-600" },
  violet: { bar: "bg-violet-500", chip: "bg-violet-500/10 text-violet-600", accent: "text-violet-600", spark: "#8b5cf6", panel: "border-violet-500/15 bg-violet-500/5", panelText: "text-violet-600" },
};

export function Sparkline({ points = [], color = "#2563eb", className = "" }) {
  const values = points.length ? points : [0, 0];
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 32 - ((value - min) / range) * 28;
    return `${x},${y}`;
  }).join(" ");
  const last = coords.split(" ").at(-1)?.split(",") || [0, 0];

  return (
    <svg viewBox="0 0 100 36" aria-hidden="true" className={cn("h-10 w-24 shrink-0 overflow-visible", className)}>
      <polyline points={coords} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3" fill={color} />
    </svg>
  );
}

Sparkline.propTypes = {
  points: PropTypes.arrayOf(PropTypes.number),
  color: PropTypes.string,
  className: PropTypes.string,
};

/**
 * The single stat card used by both the homepage overview row and the usage
 * board. `metrics` renders the mini split panels (输入/输出/缓存 …); when a card
 * has no natural breakdown it falls back to the one-line `detail`. `points`
 * drives the trailing sparkline — pass it only when there is a per-bucket
 * series, otherwise the card renders value-only.
 */
export default function StatCard({
  icon,
  eyebrow,
  value,
  valueTitle,
  tone = "primary",
  points,
  metrics,
  detail,
  loading = false,
  className,
}) {
  const palette = TONES[tone] || TONES.primary;

  return (
    <Card padding="none" className={cn("group relative min-w-0 overflow-hidden px-4 py-3", className)}>
      <div aria-hidden="true" className={cn("absolute inset-x-0 top-0 h-[2px]", palette.bar)} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className={cn("material-symbols-outlined grid size-8 shrink-0 place-items-center rounded-lg text-[18px]", palette.chip)}>
              {icon}
            </span>
            <span className="truncate text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">{eyebrow}</span>
          </div>
          {/* While a range switch is in flight the previous range's number is no
              longer valid, so show a placeholder instead of a value that reads
              as current. aria-busy announces the pending update to AT. */}
          {loading ? (
            <div className="mt-2.5 flex items-center gap-2" aria-busy="true" aria-label="正在计算">
              <Skeleton className="h-7 w-24" />
              <span className="material-symbols-outlined animate-spin text-[16px] text-primary">progress_activity</span>
            </div>
          ) : (
            <p className={cn("mt-2.5 truncate text-2xl font-bold tracking-tight", palette.accent)} title={valueTitle || value}>
              {value}
            </p>
          )}
        </div>
        {!loading && points?.length ? <Sparkline points={points} color={palette.spark} /> : null}
      </div>

      {loading ? (
        <div className="mt-2 flex gap-1.5" aria-hidden="true">
          {Array.from({ length: metrics?.length || (detail ? 1 : 2) }, (_, index) => (
            <Skeleton key={index} className="h-8 flex-1" />
          ))}
        </div>
      ) : metrics?.length ? (
        <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}>
          {metrics.map((metric) => {
            const metricPalette = TONES[metric.tone] || palette;
            return (
              <div key={metric.label} className={cn("min-w-0 rounded-md border px-1.5 py-1 text-center", metricPalette.panel)}>
                <div className={cn("truncate text-[11px] font-semibold leading-tight", metricPalette.panelText)} title={metric.title || metric.value}>
                  {metric.value}
                </div>
                <div className="mt-0.5 truncate text-[9px] leading-tight text-text-muted">{metric.label}</div>
              </div>
            );
          })}
        </div>
      ) : detail ? (
        <p className="mt-1.5 truncate text-[11px] text-text-muted" title={detail}>{detail}</p>
      ) : null}
    </Card>
  );
}

StatCard.propTypes = {
  icon: PropTypes.string.isRequired,
  eyebrow: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  valueTitle: PropTypes.string,
  tone: PropTypes.oneOf(Object.keys(TONES)),
  points: PropTypes.arrayOf(PropTypes.number),
  metrics: PropTypes.arrayOf(PropTypes.shape({
    label: PropTypes.string.isRequired,
    value: PropTypes.string.isRequired,
    title: PropTypes.string,
    tone: PropTypes.oneOf(Object.keys(TONES)),
  })),
  detail: PropTypes.string,
  loading: PropTypes.bool,
  className: PropTypes.string,
};
