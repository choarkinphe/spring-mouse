"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, ConfirmModal } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  return <span className={LOG_LEVEL_COLORS[levelTag] || "text-green-400"}>{line}</span>;
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function fileKey(session, name) {
  return `${session}\u0000${name}`;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [requestLogData, setRequestLogData] = useState(null);
  const [expandedSessions, setExpandedSessions] = useState({});
  const [activeView, setActiveView] = useState({ type: "console" });
  const [filePreview, setFilePreview] = useState(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [clearTarget, setClearTarget] = useState(null);
  const [clearing, setClearing] = useState(false);
  const logRef = useRef(null);

  const loadRequestLogStorage = useCallback(async () => {
    setLoadingStorage(true);
    setStorageError("");
    try {
      const response = await fetch("/api/system/request-log-files", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取请求调试文件");
      setRequestLogData(payload);
    } catch (error) {
      setStorageError(error.message || "无法读取请求调试文件");
    } finally {
      setLoadingStorage(false);
    }
  }, []);

  useEffect(() => {
    loadRequestLogStorage();
  }, [loadRequestLogStorage]);

  const handleClearConsole = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
    } catch (error) {
      console.error("Failed to clear console logs:", error);
    }
  };

  const toggleSession = async (name) => {
    if (expandedSessions[name]) {
      setExpandedSessions((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      return;
    }

    try {
      const response = await fetch(`/api/system/request-log-files?session=${encodeURIComponent(name)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取日志文件列表");
      setExpandedSessions((current) => ({ ...current, [name]: payload.files || [] }));
    } catch (error) {
      setStorageError(error.message || "无法读取日志文件列表");
    }
  };

  const selectFile = async (session, name) => {
    const selectedFile = { type: "file", session, name };
    setActiveView(selectedFile);
    setFilePreview(null);
    setLoadingPreview(true);
    setStorageError("");
    try {
      const response = await fetch(`/api/system/request-log-files?session=${encodeURIComponent(session)}&file=${encodeURIComponent(name)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取日志文件");
      setFilePreview(payload);
    } catch (error) {
      setStorageError(error.message || "无法读取日志文件");
    } finally {
      setLoadingPreview(false);
    }
  };

  const confirmClear = async () => {
    if (!clearTarget) return;
    setClearing(true);
    setStorageNotice("");
    try {
      const query = clearTarget === "all" ? "" : `?session=${encodeURIComponent(clearTarget)}`;
      const response = await fetch(`/api/system/request-log-files${query}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error === "Log session is still active" ? "该日志仍在写入，暂时不能删除" : payload.error || "清理日志失败");
      const skippedActive = payload.skippedActiveSessions || [];
      setExpandedSessions((current) => {
        if (clearTarget === "all") {
          return Object.fromEntries(Object.entries(current).filter(([name]) => skippedActive.includes(name)));
        }
        const next = { ...current };
        delete next[clearTarget];
        return next;
      });
      if (activeView.type === "file" && (clearTarget === "all" || activeView.session === clearTarget) && !skippedActive.includes(activeView.session)) {
        setActiveView({ type: "console" });
        setFilePreview(null);
      }
      if (skippedActive.length) {
        setStorageNotice(`已清理历史日志；${skippedActive.length} 个正在写入的会话已保留。`);
      } else {
        setStorageNotice(clearTarget === "all" ? "历史请求日志已清理。" : "请求日志已删除。");
      }
      setClearTarget(null);
      await loadRequestLogStorage();
    } catch (error) {
      setStorageError(error.message || "清理日志失败");
    } finally {
      setClearing(false);
    }
  };

  useEffect(() => {
    const eventSource = new EventSource("/api/translator/console-logs/stream");
    eventSource.onopen = () => setConnected(true);
    eventSource.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "init") {
        setLogs(message.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (message.type === "line") {
        setLogs((current) => {
          const next = [...current, message.line];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (message.type === "lines") {
        setLogs((current) => {
          const next = [...current, ...message.lines];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (message.type === "clear") {
        setLogs([]);
      }
    };
    eventSource.onerror = () => setConnected(false);
    return () => eventSource.close();
  }, []);

  useEffect(() => {
    if (activeView.type === "console" && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [activeView.type, logs]);

  const storage = requestLogData?.storage;
  const sessions = requestLogData?.sessions || [];
  const rootFiles = requestLogData?.rootFiles || [];
  const activeFileKey = activeView.type === "file" ? fileKey(activeView.session, activeView.name) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <div className="shrink-0 px-1">
        <h2 className="font-semibold">日志中心</h2>
        <p className="mt-0.5 text-sm text-text-muted">默认查看当前控制台；从左侧文件列表选择日志即可预览内容。</p>
      </div>

      {storageError && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{storageError}</p>}
      {storageNotice && <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-500">{storageNotice}</p>}

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="grid h-full min-h-0 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border bg-surface-1/70 lg:border-b-0 lg:border-r">
            <div className="shrink-0 border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0"><h3 className="text-sm font-semibold">日志来源</h3><p className="mt-1 text-xs text-text-muted">{storage?.sessions || 0} 个会话 · {storage?.files || 0} 个文件 · {formatBytes(storage?.bytes)}</p><p className="mt-1 truncate font-mono text-[10px] text-text-muted/70" title={storage?.path || ""}>{storage?.path || "正在读取日志目录…"}</p></div>
              </div>
            </div>
            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
              <div className={`flex items-center rounded-lg transition-colors ${activeView.type === "console" ? "bg-brand-500/15 text-brand-500" : "text-text-main hover:bg-surface-2"}`}>
                <button type="button" onClick={() => { setActiveView({ type: "console" }); setFilePreview(null); }} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left text-sm">
                  <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-text-muted"}`} />
                  <span className="material-symbols-outlined text-[18px]">terminal</span>
                  <span className="min-w-0 flex-1 font-medium">当前控制台</span>
                  <span className="text-[11px] text-text-muted">实时</span>
                </button>
                <button type="button" onClick={handleClearConsole} title="清空当前控制台显示" aria-label="清空当前控制台显示" className="mr-1 rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-main"><span className="material-symbols-outlined text-[15px]">delete</span></button>
              </div>

              <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">请求调试文件</span>
                <div className="flex items-center gap-0.5">
                  <button type="button" onClick={loadRequestLogStorage} disabled={loadingStorage} title="刷新文件列表" aria-label="刷新文件列表" className="rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"><span className={`material-symbols-outlined text-[15px] ${loadingStorage ? "animate-spin" : ""}`}>refresh</span></button>
                  <button type="button" onClick={() => setClearTarget("all")} disabled={!storage?.files} title="清空全部请求调试文件" aria-label="清空全部请求调试文件" className="rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"><span className="material-symbols-outlined text-[15px]">delete_sweep</span></button>
                </div>
              </div>
              {!requestLogData && loadingStorage ? <p className="px-3 py-4 text-xs text-text-muted">正在读取…</p> : null}
              {sessions.length === 0 && rootFiles.length === 0 && !loadingStorage ? <p className="px-3 py-4 text-xs leading-5 text-text-muted">暂无请求调试文件。可在“设置 → 网络与可观测性”中临时开启完整请求/响应文件日志。</p> : null}
              {sessions.map((session) => {
                const files = expandedSessions[session.name];
                return (
                  <div key={session.name} className="mb-1">
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => toggleSession(session.name)} className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left hover:bg-surface-2">
                        <div className="flex items-center gap-1.5"><span className={`material-symbols-outlined text-[16px] ${session.active ? "text-green-500" : "text-amber-400"}`}>{files ? "folder_open" : "folder"}</span><span className="truncate font-mono text-xs" title={session.name}>{session.name}</span>{session.active && <span className="shrink-0 rounded bg-green-500/10 px-1 py-0.5 text-[9px] font-semibold text-green-500">写入中</span>}</div>
                        <p className="mt-1 pl-[23px] text-[11px] text-text-muted">{session.files} 个文件 · {formatBytes(session.bytes)}</p>
                      </button>
                      <button type="button" onClick={() => setClearTarget(session.name)} disabled={session.active} title={session.active ? "正在写入，完成后才可删除" : "删除该日志会话"} aria-label={`删除 ${session.name}`} className="rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"><span className="material-symbols-outlined text-[15px]">delete</span></button>
                    </div>
                    {files && <div className="ml-3 border-l border-border pl-2">{files.map((file) => {
                      const key = fileKey(session.name, file.name);
                      return <button key={key} type="button" onClick={() => selectFile(session.name, file.name)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${activeFileKey === key ? "bg-brand-500/15 text-brand-500" : "text-text-muted hover:bg-surface-2 hover:text-text-main"}`}><span className="material-symbols-outlined text-[15px]">description</span><span className="min-w-0 flex-1 truncate font-mono">{file.name}</span><span className="shrink-0 text-[10px]">{formatBytes(file.bytes)}</span></button>;
                    })}</div>}
                  </div>
                );
              })}
              {rootFiles.length > 0 && <div className="mt-3 border-t border-border pt-2">{rootFiles.map((file) => <p key={file.name} className="flex items-center justify-between px-3 py-1.5 font-mono text-xs text-text-muted"><span className="truncate">{file.name}</span><span>{formatBytes(file.bytes)}</span></p>)}</div>}
            </div>
          </aside>

          <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-black/[0.02] dark:bg-black/20">
            {activeView.type === "console" ? (
              <>
                <div className="shrink-0 border-b border-border px-4 py-3"><h3 className="font-semibold">当前控制台</h3><p className="text-xs text-text-muted">{connected ? "已连接，正在接收实时输出" : "正在连接实时输出…"}</p></div>
                <div ref={logRef} className="custom-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain bg-black p-4 font-mono text-xs leading-5">{logs.length === 0 ? <span className="text-text-muted">暂无控制台日志。</span> : <div>{logs.map((line, index) => <div key={index}>{colorLine(line)}</div>)}</div>}</div>
                <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-text-muted">清空显示仅清理当前服务进程的内存缓冲，不会删除请求调试文件。</p>
              </>
            ) : (
              <>
                <div className="shrink-0 border-b border-border px-4 py-3"><h3 className="truncate font-mono text-sm font-semibold">{activeView.name}</h3><p className="mt-1 text-xs text-text-muted">{activeView.session} {filePreview ? `· ${formatBytes(filePreview.bytes)}` : ""}</p></div>
                {loadingPreview ? <div className="flex flex-1 items-center justify-center text-sm text-text-muted">正在读取文件内容…</div> : filePreview ? <><div className="custom-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain bg-black p-4"><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-200">{filePreview.content}</pre></div>{filePreview.truncated && <p className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-500">文件较大，页面仅显示前 {formatBytes(256 * 1024)}。</p>}</> : <div className="flex flex-1 items-center justify-center text-sm text-text-muted">无法显示文件内容。</div>}
              </>
            )}
          </section>
        </div>
      </Card>

      <p className="shrink-0 px-1 text-xs text-text-muted">完整请求/响应副本可能含敏感内容并快速占用磁盘。仅在排障时临时开启，完成后及时关闭和清理。</p>

      <ConfirmModal
        isOpen={clearTarget !== null}
        onClose={() => !clearing && setClearTarget(null)}
        onConfirm={confirmClear}
        title={clearTarget === "all" ? "清空全部请求调试文件？" : "删除这条请求调试日志？"}
        message={clearTarget === "all" ? `将删除 logs/ 中已完成的历史日志（共 ${storage?.files || 0} 个文件，${formatBytes(storage?.bytes)}）。正在写入的 ${storage?.activeSessions || 0} 个会话会自动保留。` : "将永久删除该会话目录中的全部请求和响应副本。此操作无法撤销。"}
        confirmText={clearTarget === "all" ? "清空全部" : "删除日志"}
        cancelText="取消"
        loading={clearing}
      />
    </div>
  );
}
