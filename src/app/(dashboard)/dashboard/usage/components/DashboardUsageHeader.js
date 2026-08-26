"use client";

import { useEffect, useState } from "react";

const STATUS_REFRESH_INTERVAL = 15_000;
const QUEUE_WARNING_LENGTH = 500;
const QUEUE_WARNING_PENDING = 100;
const REDIS_LATENCY_WARNING_MS = 25;

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
  if (bytes === null || bytes === undefined || bytes === "") return "—";
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024 * 1024) return `${Math.max(0, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${Math.max(0, Math.round(value / (1024 * 1024)))} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatLatency(latencyMs) {
  const value = Number(latencyMs);
  if (!Number.isFinite(value)) return "—";
  return value < 10 ? `${value.toFixed(1)}ms` : `${Math.round(value)}ms`;
}

function formatHeartbeat(ageMs) {
  if (ageMs === null || ageMs === undefined || ageMs === "") return "无心跳";
  const value = Number(ageMs);
  if (!Number.isFinite(value)) return "无心跳";
  if (value < 1000) return "刚刚";
  return `${Math.round(value / 1000)}秒前`;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const TONE_CLASSES = {
  default: "text-text-main",
  muted: "text-text-muted",
  success: "text-emerald-400",
  warning: "text-amber-400",
  danger: "text-rose-400",
};

function StatusMetric({ icon, label, value, title, tone = "default" }) {
  const toneClass = TONE_CLASSES[tone] || TONE_CLASSES.default;
  return (
    <div className="flex min-w-0 items-center gap-2" title={title || `${label}：${value}`}>
      <span className={`material-symbols-outlined text-[17px] ${tone === "default" ? "text-text-muted" : toneClass}`}>{icon}</span>
      <div className="min-w-0 leading-tight">
        <p className="text-[10px] font-medium tracking-wide text-text-muted">{label}</p>
        <p className={`truncate text-xs font-semibold tabular-nums ${toneClass}`}>{value}</p>
      </div>
    </div>
  );
}

function getSystemHealth(systemStatus, infrastructureStatus) {
  if (!systemStatus || !infrastructureStatus) {
    return { color: "bg-slate-500", glow: "", label: "系统与 Redis 状态读取中" };
  }

  const redis = infrastructureStatus.redis;
  const usageQueue = infrastructureStatus.usageQueue;
  if (redis?.configured && !redis.connected) {
    return { color: "bg-rose-500", glow: "shadow-[0_0_8px_rgba(244,63,94,0.8)]", label: "Redis 连接异常" };
  }
  if (usageQueue?.configured && usageQueue.writerHealthy === false) {
    return { color: "bg-rose-500", glow: "shadow-[0_0_8px_rgba(244,63,94,0.8)]", label: "SQLite Writer 心跳异常" };
  }

  const pending = Number(usageQueue?.pending) || 0;
  const queueLength = Number(usageQueue?.length) || 0;
  const redisLatency = Number(redis?.latencyMs) || 0;
  if (pending >= QUEUE_WARNING_PENDING || queueLength >= QUEUE_WARNING_LENGTH || redisLatency >= REDIS_LATENCY_WARNING_MS) {
    return {
      color: "bg-amber-400",
      glow: "shadow-[0_0_8px_rgba(251,191,36,0.8)]",
      label: `实时存储存在压力（队列 ${queueLength}，Redis ${formatLatency(redisLatency)}）`,
    };
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

  const redisLabel = redis?.configured ? `Redis ${formatLatency(redis.latencyMs)}` : "Redis 未启用";
  return { color: "bg-emerald-400", glow: "shadow-[0_0_8px_rgba(52,211,153,0.8)]", label: `系统运行正常 · ${redisLabel}` };
}

export default function DashboardUsageHeader({ initialSystemStatus = null }) {
  // The dashboard server component provides the first system snapshot. Redis and
  // writer health are loaded independently so an unhealthy queue never blocks page rendering.
  const [systemStatus, setSystemStatus] = useState(initialSystemStatus);
  const [infrastructureStatus, setInfrastructureStatus] = useState(null);

  useEffect(() => {
    let disposed = false;

    const loadStatus = async () => {
      const [systemResult, infrastructureResult] = await Promise.allSettled([
        fetch("/api/system/status", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) throw new Error(`System status HTTP ${response.status}`);
          return response.json();
        }),
        fetch("/api/health", { cache: "no-store" }).then((response) => response.json()),
      ]);

      if (disposed) return;
      if (systemResult.status === "fulfilled") setSystemStatus(systemResult.value);
      if (infrastructureResult.status === "fulfilled") setInfrastructureStatus(infrastructureResult.value);
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
  const systemHealth = getSystemHealth(systemStatus, infrastructureStatus);
  const redis = infrastructureStatus?.redis;
  const usageQueue = infrastructureStatus?.usageQueue;
  const redisConfigured = redis?.configured !== false;
  const redisConnected = redisConfigured && redis?.connected === true;
  const queueLength = optionalNumber(usageQueue?.length);
  const pendingCount = optionalNumber(usageQueue?.pending);
  const queueWarning = (queueLength || 0) >= QUEUE_WARNING_LENGTH || (pendingCount || 0) >= QUEUE_WARNING_PENDING;

  const redisValue = !infrastructureStatus
    ? "加载中"
    : !redisConfigured
      ? "未启用"
      : redisConnected
        ? `正常 ${formatLatency(redis.latencyMs)}`
        : "连接失败";
  const redisTone = !infrastructureStatus || !redisConfigured
    ? "muted"
    : redisConnected
      ? Number(redis.latencyMs) >= REDIS_LATENCY_WARNING_MS ? "warning" : "success"
      : "danger";
  const queueValue = !infrastructureStatus
    ? "加载中"
    : !usageQueue?.configured
      ? "未启用"
      : queueLength === null
        ? "不可用"
        : `${queueLength} 条`;
  const writerValue = !infrastructureStatus
    ? "加载中"
    : !usageQueue?.configured
      ? "未启用"
      : usageQueue.writerHealthy
        ? "正常"
        : "异常";

  const redisDetails = redisConnected
    ? `Redis 已连接，延迟 ${formatLatency(redis.latencyMs)}；${redis.keyCount ?? "—"} 个 Key；RSS ${formatBytes(redis.memory?.rssBytes)}；AOF ${formatBytes(redis.persistence?.aofSizeBytes)}。`
    : redis?.error || "Redis 当前不可用。";
  const queueDetails = usageQueue?.configured
    ? `Stream 长度 ${queueLength ?? "—"}，Pending ${pendingCount ?? "—"}。`
    : "本地开发环境未启用 Redis 写入队列。";
  const writerDetails = usageQueue?.configured
    ? `SQLite Writer ${usageQueue.writerHealthy ? "心跳正常" : "心跳异常"}，最近心跳 ${formatHeartbeat(usageQueue.writerHeartbeatAgeMs)}。`
    : "本地开发环境使用同步 SQLite 回退路径。";
  const processMemoryDetails = systemStatus?.memory
    ? `RSS ${formatBytes(systemStatus.memory.rssBytes)}；Heap ${formatBytes(systemStatus.memory.heapUsedBytes)} / ${formatBytes(systemStatus.memory.heapTotalBytes)}；External ${formatBytes(systemStatus.memory.externalBytes)}；ArrayBuffers ${formatBytes(systemStatus.memory.arrayBuffersBytes)}。`
    : "Spring Mouse 服务进程内存读取中。";

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

      <div className="flex w-full shrink-0 self-start border-t border-border/70 pt-3 xl:w-auto xl:self-auto xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
        <div className="flex w-full flex-col gap-3">
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
              title={processMemoryDetails}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-border/60 pt-3 sm:grid-cols-4">
            <StatusMetric icon="dns" label="Redis" value={redisValue} tone={redisTone} title={redisDetails} />
            <StatusMetric
              icon="memory_alt"
              label="Redis 内存"
              value={redisConnected ? formatBytes(redis.memory?.usedBytes) : "—"}
              tone={redisConnected ? "default" : "muted"}
              title={redisDetails}
            />
            <StatusMetric
              icon="queue"
              label="写入队列"
              value={queueValue}
              tone={queueWarning ? "warning" : usageQueue?.configured ? "success" : "muted"}
              title={queueDetails}
            />
            <StatusMetric
              icon="sync_saved_locally"
              label="SQLite Writer"
              value={writerValue}
              tone={!usageQueue?.configured ? "muted" : usageQueue.writerHealthy ? "success" : "danger"}
              title={writerDetails}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
