"use client";

import { memo, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import { ConfirmModal } from "@/shared/components/Modal";
import { formatMs, formatTime, formatTokPerSec } from "../chatDebugLib.js";

const PHASE_LABELS = {
  waiting: "等待首包",
  streaming: "流式返回中",
  done: "成功",
  error: "失败",
  aborted: "已停止",
};

const PHASE_VARIANTS = {
  waiting: "warning",
  streaming: "info",
  done: "success",
  error: "error",
  aborted: "default",
};

const KEY_STATUS = {
  ready: { label: "密钥已就绪", dot: "bg-emerald-500" },
  loading: { label: "密钥加载中", dot: "bg-amber-500" },
  error: { label: "密钥不可用", dot: "bg-red-500" },
};

function MetricRow({ label, value, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="shrink-0 text-xs text-text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium text-text-main" title={hint || undefined}>
        {value}
      </span>
    </div>
  );
}

MetricRow.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node,
  hint: PropTypes.string,
};

function Timeline({ timeline, total }) {
  if (!timeline || timeline.length < 2) return null;
  const span = Math.max(1, timeline[timeline.length - 1]);
  return (
    <div className="mt-2" title="每个竖条为一个网络分块的到达时刻">
      <div className="flex h-8 items-end gap-px">
        {timeline.map((t, index) => (
          <div
            key={index}
            className="min-w-px w-full rounded-sm bg-brand-500/70"
            style={{ height: `${Math.max(8, Math.round((t / span) * 100))}%` }}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-text-muted">
        <span>0 ms</span>
        <span>{formatMs(total)}</span>
      </div>
    </div>
  );
}

Timeline.propTypes = {
  timeline: PropTypes.arrayOf(PropTypes.number),
  total: PropTypes.number,
};

function ServerRow({ server }) {
  if (!server) return null;
  const connection = server.connectionId ? String(server.connectionId).slice(0, 8) : "";
  return (
    <div className="mt-2 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-text-muted">
      服务端视角：TTFT {formatMs(server.ttft)} · 总 {formatMs(server.total)}
      {connection ? ` · 连接 ${connection}` : ""}
    </div>
  );
}

ServerRow.propTypes = {
  server: PropTypes.shape({
    ttft: PropTypes.number,
    total: PropTypes.number,
    connectionId: PropTypes.string,
  }),
};

function HistorySection({ history, onClear }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="border-t border-border">
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">历史记录</span>
        {history.length > 0 ? (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="text-xs text-text-muted transition-colors hover:text-red-500"
          >
            清空
          </button>
        ) : null}
      </div>
      {history.length === 0 ? (
        <div className="px-4 pb-3 pt-1 text-xs text-text-muted">暂无运行记录</div>
      ) : (
        <div className="custom-scrollbar max-h-[38vh] overflow-y-auto px-2 pb-3">
          <table className="w-full table-fixed text-xs">
            <thead>
              <tr className="text-text-muted">
                <th className="w-14 px-1 py-1 text-left font-medium">时间</th>
                <th className="px-1 py-1 text-left font-medium">模型</th>
                <th className="w-16 px-1 py-1 text-right font-medium">TTFT</th>
                <th className="w-16 px-1 py-1 text-right font-medium">总时长</th>
                <th className="w-14 px-1 py-1 text-right font-medium">tok/s</th>
                <th className="w-9 px-1 py-1 text-center font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {history.map((run) => (
                <tr
                  key={run.id}
                  className={`border-t border-border-subtle ${run.status === "error" ? "text-red-500" : "text-text-main"}`}
                  title={run.error ? `${run.model}\n${run.error}` : run.model}
                >
                  <td className="px-1 py-1 tabular-nums text-text-muted">{formatTime(run.time)}</td>
                  <td className="truncate px-1 py-1 font-mono text-[11px]">{run.model}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{formatMs(run.ttft)}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{formatMs(run.total)}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{formatTokPerSec(run.tokPerSec)}</td>
                  <td className="px-1 py-1 text-center">
                    {run.status === "done" ? "✓" : run.status === "aborted" ? "■" : "✕"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => { onClear(); setConfirmOpen(false); }}
        title="清空历史记录"
        message="将删除本地保存的全部运行记录，此操作不可恢复。"
        confirmText="清空"
        variant="danger"
      />
    </div>
  );
}

HistorySection.propTypes = {
  history: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    time: PropTypes.string,
    model: PropTypes.string,
    ttft: PropTypes.number,
    total: PropTypes.number,
    tokPerSec: PropTypes.number,
    status: PropTypes.string,
    error: PropTypes.string,
  })).isRequired,
  onClear: PropTypes.func.isRequired,
};

function MetricsPanel({ liveRun, history, onClearHistory, onNewSession, keyStatus }) {
  // Own the elapsed ticker here so streaming updates don't re-render the chat.
  const [elapsed, setElapsed] = useState(0);
  const running = liveRun?.phase === "waiting" || liveRun?.phase === "streaming";
  const startedAtPerf = liveRun?.startedAtPerf;

  useEffect(() => {
    if (!running || !startedAtPerf) return undefined;
    const timer = setInterval(() => {
      setElapsed(performance.now() - startedAtPerf);
    }, 250);
    return () => clearInterval(timer);
  }, [running, startedAtPerf]);

  // Derive the display value: zero while waiting for the first byte, the live
  // tick while streaming, otherwise the finalized total (rendered separately).
  const displayElapsed = liveRun?.phase === "waiting" ? 0 : elapsed;

  const keyMeta = KEY_STATUS[keyStatus] || KEY_STATUS.loading;
  const usageHint = liveRun?.usageEstimated
    ? "上游未返回精确用量，已按字符数估算"
    : "来自网关注入的终止 usage 分块";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${keyMeta.dot}`} />
          <span className="truncate text-xs text-text-muted" title={keyMeta.label}>{keyMeta.label}</span>
        </div>
        <Button variant="outline" size="sm" icon="add" onClick={onNewSession}>新会话</Button>
      </div>

      <div className="border-t border-border px-4 pb-2 pt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">本次运行</span>
          {liveRun ? <Badge variant={PHASE_VARIANTS[liveRun.phase] || "default"} size="sm" dot>{PHASE_LABELS[liveRun.phase] || liveRun.phase}</Badge> : null}
        </div>
        {!liveRun ? (
          <div className="py-2 text-xs text-text-muted">发送消息后开始测量</div>
        ) : (
          <>
            <div className="mb-1 truncate font-mono text-[11px] text-text-muted" title={liveRun.model}>{liveRun.model}</div>
            <MetricRow label="TTFT（首 token）" value={formatMs(liveRun.ttft)} />
            <MetricRow
              label={running ? "已用时" : "总时长"}
              value={running ? formatMs(displayElapsed) : formatMs(liveRun.total)}
            />
            <MetricRow label="网络分块" value={liveRun.chunks != null ? `${liveRun.chunks} 个` : "—"} />
            {liveRun.avgIntervalMs != null ? (
              <MetricRow label="平均分块间隔" value={`${liveRun.avgIntervalMs} ms`} />
            ) : null}
            <MetricRow
              label={`输出 tokens${liveRun.usageEstimated ? "（估算）" : ""}`}
              value={liveRun.completionTokens != null ? liveRun.completionTokens : "—"}
              hint={liveRun.completionTokens != null ? usageHint : undefined}
            />
            {liveRun.promptTokens != null ? <MetricRow label="输入 tokens" value={liveRun.promptTokens} /> : null}
            <MetricRow label="生成速率" value={formatTokPerSec(liveRun.tokPerSec)} />
            {liveRun.error ? (
              <div className="mt-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-500" title={liveRun.error}>
                <div className="line-clamp-3 break-all">{liveRun.error}</div>
              </div>
            ) : null}
            <Timeline timeline={liveRun.timeline} total={liveRun.total} />
            <ServerRow server={liveRun.server} />
          </>
        )}
      </div>

      <HistorySection history={history} onClear={onClearHistory} />
    </div>
  );
}

MetricsPanel.propTypes = {
  liveRun: PropTypes.shape({
    phase: PropTypes.string,
    model: PropTypes.string,
    ttft: PropTypes.number,
    total: PropTypes.number,
    chunks: PropTypes.number,
    avgIntervalMs: PropTypes.number,
    completionTokens: PropTypes.number,
    promptTokens: PropTypes.number,
    usageEstimated: PropTypes.bool,
    tokPerSec: PropTypes.number,
    error: PropTypes.string,
    timeline: PropTypes.arrayOf(PropTypes.number),
    server: PropTypes.shape({ ttft: PropTypes.number, total: PropTypes.number, connectionId: PropTypes.string }),
    startedAtPerf: PropTypes.number,
  }),
  history: PropTypes.arrayOf(PropTypes.object).isRequired,
  onClearHistory: PropTypes.func.isRequired,
  onNewSession: PropTypes.func.isRequired,
  keyStatus: PropTypes.oneOf(["loading", "ready", "error"]),
};

export default memo(MetricsPanel);
