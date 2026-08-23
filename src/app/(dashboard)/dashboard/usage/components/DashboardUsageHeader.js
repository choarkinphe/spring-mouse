"use client";

import { useEffect, useState } from "react";

const STATUS_REFRESH_INTERVAL = 15_000;

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}天 ${hours}时`;
  if (hours > 0) return `${hours}时 ${minutes}分`;
  return `${minutes}分`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024 * 1024) return `${Math.max(0, Math.round(value / (1024 * 1024)))} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function StatusMetric({ icon, label, value, title }) {
  return (
    <div className="flex min-w-0 items-center gap-2" title={title || `${label}：${value}`}>
      <span className="material-symbols-outlined text-[17px] text-text-muted">{icon}</span>
      <div className="min-w-0 leading-tight">
        <p className="text-[10px] font-medium tracking-wide text-text-muted">{label}</p>
        <p className="truncate text-xs font-semibold tabular-nums text-text-main">{value}</p>
      </div>
    </div>
  );
}

function getSystemHealth(systemStatus) {
  if (!systemStatus) {
    return { color: "bg-slate-500", glow: "", label: "系统状态读取中" };
  }

  const processCpu = Number(systemStatus.cpu?.processPercent);
  const oneMinuteLoad = Number(systemStatus.cpu?.loadAverage?.[0]);
  const coreCount = Number(systemStatus.cpu?.cores);
  const systemLoad = Number.isFinite(oneMinuteLoad) && coreCount > 0
    ? (oneMinuteLoad / coreCount) * 100
    : 0;
  const loadPercent = Math.max(Number.isFinite(processCpu) ? processCpu : 0, systemLoad);

  if (loadPercent >= 90) {
    return { color: "bg-rose-500", glow: "shadow-[0_0_8px_rgba(244,63,94,0.8)]", label: `系统负载较高（${loadPercent.toFixed(0)}%）` };
  }
  if (loadPercent >= 70) {
    return { color: "bg-amber-400", glow: "shadow-[0_0_8px_rgba(251,191,36,0.8)]", label: `系统负载偏高（${loadPercent.toFixed(0)}%）` };
  }

  return { color: "bg-emerald-400", glow: "shadow-[0_0_8px_rgba(52,211,153,0.8)]", label: `系统运行正常（${loadPercent.toFixed(0)}%）` };
}

export default function DashboardUsageHeader({ initialSystemStatus = null }) {
  // The dashboard server component provides the first snapshot so uptime and version
  // render with the page instead of waiting for a separate authenticated API call.
  const [systemStatus, setSystemStatus] = useState(initialSystemStatus);

  useEffect(() => {
    let disposed = false;

    const loadStatus = async () => {
      try {
        const response = await fetch("/api/system/status", { cache: "no-store" });
        if (!response.ok) return;
        const status = await response.json();
        if (!disposed) setSystemStatus(status);
      } catch {
        // A failed status refresh must not affect the usage dashboard itself.
      }
    };

    loadStatus();
    const timer = window.setInterval(loadStatus, STATUS_REFRESH_INTERVAL);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const cpuPercent = systemStatus?.cpu?.processPercent;
  const cpuValue = typeof cpuPercent === "number" ? `${cpuPercent.toFixed(1)}%` : "采样中";
  const systemHealth = getSystemHealth(systemStatus);

  return (
    <section className="relative flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-surface/80 px-5 py-4 shadow-sm xl:flex-row xl:items-center xl:justify-between">
      <span
        aria-label={systemHealth.label}
        title={systemHealth.label}
        className={`absolute right-5 top-4 size-2 rounded-full ${systemHealth.color} ${systemHealth.glow}`}
      />
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/[0.09] text-primary shadow-[0_0_22px_rgba(59,130,246,0.12)]">
          <span className="material-symbols-outlined text-[24px]">insights</span>
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-[0.12em] text-primary">今日 · 实时概览</p>
          <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-text-main">调用、成本与渠道额度，一眼掌握</h1>
          <p className="mt-0.5 text-sm text-text-muted">默认统计今天 00:00 至当前时刻，数据会随请求实时更新。</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4 self-start border-t border-border/70 pt-3 xl:self-auto xl:border-t-0 xl:border-l xl:pl-5 xl:pt-0">
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
          <StatusMetric icon="schedule" label="运行时间" value={systemStatus ? formatDuration(systemStatus.uptimeSeconds) : "加载中"} />
          <StatusMetric icon="deployed_code" label="版本" value={systemStatus?.version ? `v${systemStatus.version}` : "—"} />
          <StatusMetric
            icon="memory"
            label="进程 CPU"
            value={cpuValue}
            title="Spring Mouse 服务进程的 CPU 占用；首次采样后显示。"
          />
          <StatusMetric
            icon="database"
            label="内存 RSS"
            value={systemStatus ? formatBytes(systemStatus.memory?.rssBytes) : "—"}
            title="Spring Mouse 服务进程实际占用的物理内存。"
          />
        </div>
      </div>
    </section>
  );
}
