"use client";

import { useState } from "react";
import Drawer from "@/shared/components/Drawer";
import { useNotificationStore } from "@/store/notificationStore";
import { cn } from "@/shared/utils/cn";
import { formatDateTime } from "@/shared/utils/datetime";
import { analyzeConnectionError, formatConnectionErrorDetails, getErrorEvidenceLayerLabel } from "@/shared/utils/connectionErrorEvidence";

export default function ConnectionFailureAnalysis({ connection, evidence, stale, relativeTime, accountName, providerName }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const notify = useNotificationStore();
  if (!evidence) return null;
  const analysis = analyzeConnectionError(evidence);
  const details = formatConnectionErrorDetails(connection, evidence, {
    accountName, providerName, time: evidence.iso ? formatDateTime(evidence.iso) : null,
  });
  const copy = async (event) => {
    event.stopPropagation();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(details);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = details;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
        } finally {
          textarea.remove();
        }
      }
      setCopied(true);
      notify.success("完整错误详情已复制");
    } catch {
      setCopied(false);
      notify.error("复制失败，请重试或从详情中选择文本复制");
    }
  };
  const openAnalysis = () => { setCopied(false); setOpen(true); };
  return (
    <>
      <div className={cn("flex min-w-0 flex-1 items-center gap-1.5", stale ? "text-[#647688]" : "text-rose-400")}>
        <button type="button" onClick={openAnalysis} aria-label={`分析失败原因：${accountName}`} title="点击分析失败原因并查看原始上游报文" className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline">
          <span className="material-symbols-outlined shrink-0 text-[14px]! leading-none">{stale ? "history" : "error"}</span>
          <span className="min-w-0 flex-1 truncate">{stale ? "上次失败分析" : "失败原因分析"} · {analysis.reason}</span>
        </button>
        {relativeTime && <span className="shrink-0 tabular-nums">{relativeTime}</span>}
        <button type="button" onClick={copy} aria-label={`复制完整错误详情：${accountName}`} title="复制完整错误详情（含原始上游报文）" className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]">
          <span className="material-symbols-outlined text-[15px]! leading-none">{copied ? "check" : "content_copy"}</span>
        </button>
      </div>
      <Drawer isOpen={open} onClose={() => setOpen(false)} title="失败原因分析" width="xl" footer={<button data-testid="copy-failure-details" type="button" onClick={copy} className="rounded-lg border border-border-subtle bg-surface-2 px-4 py-2 text-sm text-text-main hover:text-[#7dd3fc]">{copied ? "已复制完整错误详情" : "复制完整错误详情（含原始报文）"}</button>}>
        <div className="min-w-0 space-y-5 text-sm text-text-main">
          <div className="space-y-1 text-xs text-text-muted">
            <p className="break-words">{providerName} · {accountName}</p>
            <p>{getErrorEvidenceLayerLabel(evidence)} · 记录状态码 {evidence.status ?? "未知"}</p>
            {evidence.iso && <p>{formatDateTime(evidence.iso)}</p>}
            {evidence.source === "sse" && <p>SSE 传输状态不等于业务结果；HTTP 200 也可能包含错误，业务错误码见原始报文。</p>}
            {stale && <p>这是保留的历史失败记录，不代表账号当前仍然失败。</p>}
          </div>
          <section className="space-y-2 rounded-lg border border-border-subtle bg-surface-2 p-4" aria-label="失败分析结论">
            <h3 className="font-semibold">{analysis.reason}</h3>
            <p className="text-xs leading-6 text-text-muted">判断依据：{analysis.basis}</p>
            <p className="text-xs leading-6">处理建议：{analysis.suggestion}</p>
            <p className="text-xs text-text-muted">以上为基于已记录证据的分析，不是上游原文。</p>
          </section>
          <section className="space-y-2">
            <h3 className="font-semibold">错误摘要</h3>
            <p className="whitespace-pre-wrap break-words text-xs leading-6">{evidence.text}</p>
          </section>
          <section className="space-y-2">
            <h3 className="font-semibold">原始上游报文（已记录内容）</h3>
            <pre data-testid="upstream-error-raw" className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-subtle bg-surface-2 p-4 font-mono text-xs leading-6">{evidence.raw == null || evidence.raw === "" ? "未记录原始上游报文；无法从摘要还原。" : typeof evidence.raw === "string" ? evidence.raw : JSON.stringify(evidence.raw, null, 2)}</pre>
          </section>
        </div>
      </Drawer>
    </>
  );
}
