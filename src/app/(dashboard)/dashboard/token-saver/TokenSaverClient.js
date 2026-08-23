"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

export default function TokenSaverClient({ embedded = false }) {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [headroomEnabled, setHeadroomEnabled] = useState(false);
  const [headroomUrl, setHeadroomUrl] = useState("http://localhost:8787");
  const [headroomStatus, setHeadroomStatus] = useState({
    installed: false,
    running: false,
    python: null,
    loading: true,
  });
  const [headroomActionLoading, setHeadroomActionLoading] = useState(false);
  const [headroomActionError, setHeadroomActionError] = useState("");
  const [headroomExtras, setHeadroomExtras] = useState({
    version: null,
    extras: { code: false, ml: false },
    available: ["code", "ml"],
    loading: false,
  });
  const [extrasActionLoading, setExtrasActionLoading] = useState(false);
  const [extrasActionError, setExtrasActionError] = useState("");
  const [installLog, setInstallLog] = useState("");
  const [codeAware, setCodeAware] = useState(false);
  const [kompress, setKompress] = useState(true);
  const [restartingProxy, setRestartingProxy] = useState(false);
  const logPollRef = useRef(null);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [pxpipeEnabled, setPxpipeEnabled] = useState(false);
  const [pxpipeMinChars, setPxpipeMinChars] = useState(25000);
  const [pxpipeStatus, setPxpipeStatus] = useState({
    installed: false,
    installing: false,
    running: false,
    version: null,
    loading: true,
  });
  const [pxpipeHealth, setPxpipeHealth] = useState(null);
  const [showPxpipeModal, setShowPxpipeModal] = useState(false);
  const [pxpipeActionLoading, setPxpipeActionLoading] = useState(false);
  const [pxpipeActionError, setPxpipeActionError] = useState("");

  const { copied, copy } = useCopyToClipboard();

  // 多语言已移除（固定 zh-CN）：文言文档位常驻
  const visibleCavemanLevels = CAVEMAN_LEVELS;

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  // 开关即服务状态：开 → 启动压缩服务；关 → 停止。
  const handleHeadroomEnabled = async (value) => {
    const nextUrl = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(nextUrl);
    setHeadroomEnabled(value);
    setHeadroomActionError("");
    setHeadroomActionLoading(true);
    try {
      await patchSetting({ headroomEnabled: value, headroomUrl: nextUrl });
      if (value) {
        if (!headroomStatus.running && headroomStatus.canStart) {
          const res = await fetch("/api/headroom/start", { method: "POST" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "启动压缩服务失败");
        }
      } else if (headroomStatus.running && headroomStatus.localUrl !== false) {
        await fetch("/api/headroom/stop", { method: "POST" });
      }
      await refreshHeadroomStatus();
    } catch (e) {
      setHeadroomEnabled(!value);
      setHeadroomActionError(e.message);
    } finally {
      setHeadroomActionLoading(false);
    }
  };


  const refreshHeadroomStatus = useCallback(async () => {
    setHeadroomStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/headroom/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setHeadroomStatus({ ...data, loading: false });
      if (!data?.installed) {
        setHeadroomExtras({
          version: null,
          extras: { code: false, ml: false },
          available: ["code", "ml"],
          loading: false,
        });
        return;
      }
      try {
        const er = await fetch("/api/headroom/extras", {
          headers: { "Cache-Control": "no-store" },
        });
        if (!er.ok) throw new Error("extras status failed");
        const ed = await er.json();
        setHeadroomExtras((s) => ({
          ...s,
          version: ed.version ?? null,
          extras: ed.extras || { code: false, ml: false },
          available: ed.available || ["code", "ml"],
          loading: false,
        }));
      } catch {
        setHeadroomExtras({
          version: null,
          extras: { code: false, ml: false },
          available: ["code", "ml"],
          loading: false,
        });
      }
    } catch {
      setHeadroomStatus({
        installed: false,
        running: false,
        python: null,
        loading: false,
      });
      setHeadroomExtras({
        version: null,
        extras: { code: false, ml: false },
        available: ["code", "ml"],
        loading: false,
      });
    }
  }, []);

  // 状态收敛：开关已开但服务未运行（本地模式）→ 页面加载时自动启动一次
  const autoStartTriedRef = useRef(false);
  useEffect(() => {
    if (headroomStatus.loading || autoStartTriedRef.current) return;
    if (headroomEnabled && !headroomStatus.running && headroomStatus.canStart) {
      autoStartTriedRef.current = true;
      (async () => {
        try {
          await fetch("/api/headroom/start", { method: "POST" });
          await refreshHeadroomStatus();
        } catch { /* 启动失败时状态徽标会显示未运行，开关操作会再尝试 */ }
      })();
    }
  }, [headroomStatus, headroomEnabled, refreshHeadroomStatus]);

  // Poll the install log tail while a pip install is running.
  const startLogPolling = useCallback(() => {
    setInstallLog("");
    if (logPollRef.current) clearInterval(logPollRef.current);
    const tick = async () => {
      try {
        const r = await fetch("/api/headroom/extras?log=1", {
          headers: { "Cache-Control": "no-store" },
        });
        const d = await r.json().catch(() => ({}));
        if (typeof d.log === "string") setInstallLog(d.log);
      } catch { /* ignore transient poll errors */ }
    };
    tick();
    logPollRef.current = setInterval(tick, 1500);
  }, []);

  const stopLogPolling = useCallback(() => {
    if (logPollRef.current) {
      clearInterval(logPollRef.current);
      logPollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopLogPolling(), [stopLogPolling]);

  // Toggle an extra's active state (persist setting), then restart the proxy so
  // the new --code-aware / --disable-kompress flags take effect.
  const toggleExtraActive = useCallback(async (extra, value) => {
    setExtrasActionError("");
    if (extra === "code") setCodeAware(value);
    if (extra === "ml") setKompress(value);
    const key = extra === "code" ? "headroomCodeAware" : "headroomKompress";
    await patchSetting({ [key]: value });
    if (!headroomStatus.running) return;
    setRestartingProxy(true);
    try {
      const res = await fetch("/api/headroom/restart", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restart failed");
      await refreshHeadroomStatus();
    } catch (e) {
      setExtrasActionError(e.message);
    } finally {
      setRestartingProxy(false);
    }
  }, [headroomStatus.running, refreshHeadroomStatus]);

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handlePonytailEnabled = (value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  };

  const handlePonytailLevel = (level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  };

  const refreshPxpipeStatus = useCallback(async () => {
    setPxpipeStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/pxpipe/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setPxpipeStatus({ ...data, loading: false });
      if (typeof data.minChars === "number") setPxpipeMinChars(data.minChars);
    } catch {
      setPxpipeStatus({ installed: false, installing: false, running: false, version: null, loading: false });
    }
  }, []);

  const runPxpipeHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/pxpipe/health", { method: "POST" });
      setPxpipeHealth(await res.json());
    } catch (e) {
      setPxpipeHealth({ healthy: false, checks: [], error: e.message });
    }
  }, []);

  const pxpipeAction = useCallback(
    async (endpoint) => {
      setPxpipeActionError("");
      setPxpipeActionLoading(true);
      try {
        const res = await fetch(`/api/pxpipe/${endpoint}`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `PXPIPE ${endpoint} failed`);
        await refreshPxpipeStatus();
        await runPxpipeHealth();
      } catch (e) {
        setPxpipeActionError(e.message);
      } finally {
        setPxpipeActionLoading(false);
      }
    },
    [refreshPxpipeStatus, runPxpipeHealth]
  );

  const handlePxpipeEnabled = (value) => {
    setPxpipeEnabled(value);
    patchSetting({ pxpipeEnabled: value });
  };

  // 环境依赖缺失时默认自动安装全部组件：headroom-ai[proxy,code,ml]。
  // 不在乎包体积（[ml] 约 1GB torch），缺什么装什么。
  const autoInstallTriedRef = useRef(false);
  const [autoInstalling, setAutoInstalling] = useState(false);
  useEffect(() => {
    if (!headroomEnabled || headroomStatus.loading || autoInstallTriedRef.current) return;
    if (headroomStatus.installed !== false || !headroomStatus.python) return;
    autoInstallTriedRef.current = true;
    let cancelled = false;
    (async () => {
      setAutoInstalling(true);
      setExtrasActionLoading(true);
      setExtrasActionError("");
      startLogPolling();
      try {
        const res = await fetch("/api/headroom/extras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extras: ["code", "ml"] }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "自动安装失败");
      } catch (e) {
        if (!cancelled) setExtrasActionError(`自动安装依赖失败：${e.message}`);
      } finally {
        if (!cancelled) {
          stopLogPolling();
          setExtrasActionLoading(false);
          setAutoInstalling(false);
          refreshHeadroomStatus();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [headroomEnabled, headroomStatus, startLogPolling, stopLogPolling, refreshHeadroomStatus]);

  const handlePxpipeMinCharsBlur = () => {
    const next = Math.max(0, Number(pxpipeMinChars) || 25000);
    setPxpipeMinChars(next);
    patchSetting({ pxpipeMinChars: next });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setHeadroomEnabled(!!data.headroomEnabled);
          setHeadroomUrl(data.headroomUrl || "http://localhost:8787");
          setCodeAware(data.headroomCodeAware === true);
          setKompress(data.headroomKompress !== false);
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setPxpipeEnabled(!!data.pxpipeEnabled);
          if (typeof data.pxpipeMinChars === "number") setPxpipeMinChars(data.pxpipeMinChars);
          refreshHeadroomStatus();
          // PRD: run the PXPIPE health check automatically when the page opens
          refreshPxpipeStatus().then(runPxpipeHealth);
        }
      } catch {}
    };
    loadSettings();
  }, [refreshHeadroomStatus, refreshPxpipeStatus, runPxpipeHealth]);

  const headroomRunning = !!headroomStatus.running;
  const headroomStatusLabel = headroomActionLoading
    ? headroomEnabled ? "正在启用…" : "正在停用…"
    : headroomStatus.loading
      ? "检测中…"
      : headroomRunning
        ? "运行中"
        : autoInstalling && !headroomStatus.installed
          ? "自动安装依赖中…"
          : headroomStatus.localUrl !== false && !headroomStatus.installed
            ? "未安装"
            : headroomStatus.localUrl !== false
              ? "已停止"
              : "外部服务";
  const headroomLocalUrl = headroomStatus.localUrl !== false;
  const headroomCanStart = !!headroomStatus.canStart;
  const headroomManaged =
    headroomLocalUrl && !!headroomStatus.managedPid;

  const pxpipeHealthy = pxpipeHealth?.healthy === true;
  const pxpipeStatusLabel = pxpipeStatus.loading
    ? "Checking…"
    : pxpipeStatus.installing
      ? "Installing…"
      : !pxpipeStatus.installed
        ? "Not installed"
        : pxpipeHealthy
          ? "Healthy"
          : pxpipeStatus.running
            ? "Running"
            : "Stopped";
  const pxpipeChipClass =
    pxpipeHealthy || pxpipeStatus.running
      ? "bg-success/15 text-success"
      : "bg-warning/15 text-warning";

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 p-6"}>
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              bolt
            </span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              压缩工具输出{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              请求发往模型前就地压缩 git/grep/ls/tree/日志等工具输出，输入 token 减少 60-90%。
              排障必需的错误内容（is_error）自动跳过不压缩，不影响定位问题。
              适合 Claude Code/Cursor 等频繁回传大段命令输出的编码场景。
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>
        <div className="flex items-center justify-between py-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                压缩上下文{" "}
                <a
                  href="https://github.com/chopratejas/headroom"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (Headroom)
                </a>
              </p>
              <span
                className={`text-xs px-2 py-0.5 rounded ${headroomRunning ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
              >
                {headroomStatusLabel}
              </span>
            </div>
            <p className="text-sm text-text-muted mt-1">
              <span className="font-medium text-text-main">总开关</span>：
              打开即启动压缩服务，所有请求发往模型前先压缩（JSON 结构化为基础）；
              关闭则服务停止、请求原样直发。压缩失败自动降级直发，不影响可用性。
              环境依赖缺失时自动安装全部组件（含 [code] 与 [ml]，约 1GB+）。
            </p>
          </div>
          <Toggle
            checked={headroomEnabled}
            onChange={() => handleHeadroomEnabled(!headroomEnabled)}
          />
        </div>
        {headroomStatus.installed && (
          <div className={`mb-3 ml-2 pl-4 pb-4 border-l-2 ${headroomEnabled ? "border-primary/40" : "border-border"}`}>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="text-xs text-text-muted">
                压缩手段{headroomExtras.version ? ` · v${headroomExtras.version}` : ""}
                — 总开关运行时生效，切换后自动重启服务
              </span>
              {!headroomEnabled && (
                <span className="text-xs text-warning">总开关未开，以下配置将在启用后生效</span>
              )}
            </div>

            {/* AST 代码压缩 */}
            <div className={`flex items-start justify-between gap-4 py-2 ${headroomEnabled ? "" : "opacity-50"}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  代码 AST 压缩 <span className="text-xs text-text-muted font-mono">[code]</span>
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  服务运行时对代码内容做语法树（AST）级压缩：保留逻辑结构，剔除冗余格式与注释噪声。
                  覆盖 Python/JS/TS/Go/Rust/Java/C/C++/Perl。工具返回大段代码时收益最大。
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {restartingProxy && (
                  <span className="text-xs text-text-muted">重启服务中…</span>
                )}
                <Toggle
                  size="sm"
                  checked={codeAware}
                  disabled={restartingProxy}
                  onChange={() => toggleExtraActive("code", !codeAware)}
                />
              </div>
            </div>

            {/* ML 语义压缩 */}
            <div className={`flex items-start justify-between gap-4 py-2 ${headroomEnabled ? "" : "opacity-50"}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  ML 语义压缩 <span className="text-xs text-text-muted font-mono">[ml]</span>
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  服务运行时用 Kompress-v2 模型对散文、对话与智能体轨迹做语义级压缩：
                  理解内容后保留要点、去除重复表述。适合长对话与大量自然语言上下文，与代码压缩互补。
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Toggle
                  size="sm"
                  checked={kompress}
                  disabled={restartingProxy}
                  onChange={() => toggleExtraActive("ml", !kompress)}
                />
              </div>
            </div>

            {extrasActionError && (
              <p className="text-xs text-error mt-1">{extrasActionError}</p>
            )}
            {extrasActionLoading && installLog && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface-2 p-2 text-[10px] leading-tight text-text-muted whitespace-pre-wrap">
                {installLog}
              </pre>
            )}
          </div>
        )}
        <div className="flex items-center justify-between pt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              压缩模型输出{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              注入「电报体」系统提示让模型用最精炼的语言回答，输出 token 平均减少约 65%（最高 87%）。
              中文环境额外提供文言文档位，压缩率更高（80-90%）。
              适合批量问答、数据抽取等只关心内容不关心措辞的场景；对外交付文档时请关闭。
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              极简资深开发模式{" "}
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              让模型像「懒惰的资深工程师」一样写代码：严格 YAGNI（只实现被要求的）、
              优先复用标准库与现有代码、能删就不加。产出代码更短、依赖更少，
              连带节省输出 token 与后续维护成本。适合内部工具与脚本；需要详尽注释的交付项目慎用。
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={ponytailEnabled}
              onChange={() => handlePonytailEnabled(!ponytailEnabled)}
            />
          </div>
        </div>
        {/* PXPIPE hidden from UI — experimental, not exposed to users yet */}
        {false && (
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress prompts as images{" "}
                <a
                  href="https://github.com/teamchong/pxpipe"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (PXPIPE)
                </a>
              </p>
              <span className={`text-xs px-2 py-0.5 rounded ${pxpipeChipClass}`}>
                {pxpipeStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setShowPxpipeModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {pxpipeStatus.installed ? "Manage" : "Setup"}
              </button>
              <a
                href="/dashboard/pxpipe"
                className="text-xs text-primary underline hover:opacity-80"
              >
                Dashboard
              </a>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Transforms large textual context into optimized images before
              sending to the LLM. Ideal for huge prompts, tool outputs and long
              conversations.
            </p>
          </div>
          <Toggle
            checked={pxpipeEnabled}
            disabled={!pxpipeStatus.installed}
            onChange={() => handlePxpipeEnabled(!pxpipeEnabled)}
          />
        </div>
        )}
      </Card>


      <Modal
        isOpen={false}
        title={pxpipeStatus.installed ? "PXPIPE" : "Setup PXPIPE"}
        onClose={() => setShowPxpipeModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Compress prompts using multimodal encoding. Runs in-process — no
            extra server or environment variables required.
          </p>
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span className={pxpipeHealthy || pxpipeStatus.running ? "text-success" : "text-warning"}>
              {pxpipeStatusLabel}
              {pxpipeStatus.version ? ` · v${pxpipeStatus.version}` : ""}
            </span>
          </div>
          {pxpipeHealth?.checks?.length > 0 && (
            <div className="flex flex-col gap-1 rounded border border-border p-3">
              <p className="text-sm font-medium mb-1">Health check</p>
              {pxpipeHealth.checks.map((check) => (
                <div key={check.id} className="flex items-center justify-between text-xs">
                  <span className={check.ok ? "text-success" : "text-warning"}>
                    {check.ok ? "●" : "○"} {check.label}
                  </span>
                  {check.detail && (
                    <span className="text-text-muted font-mono truncate max-w-[50%]">{check.detail}</span>
                  )}
                </div>
              ))}
              {pxpipeHealth.error && (
                <p className="text-xs text-warning mt-1">{pxpipeHealth.error}</p>
              )}
            </div>
          )}
          {!pxpipeStatus.installed ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-warning">PXPIPE is not installed.</p>
              <Button
                onClick={() => pxpipeAction("install")}
                fullWidth
                disabled={pxpipeActionLoading || pxpipeStatus.installing}
              >
                {pxpipeActionLoading || pxpipeStatus.installing ? "Installing…" : "Install"}
              </Button>
              <p className="text-xs text-text-muted">
                Installs the npm package <code className="font-mono">pxpipe-proxy</code> into
                the Spring Mouse data directory. May take a few minutes.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {pxpipeStatus.running ? (
                <>
                  <Button onClick={() => pxpipeAction("restart")} variant="ghost" disabled={pxpipeActionLoading}>
                    Restart
                  </Button>
                  <Button onClick={() => pxpipeAction("stop")} variant="ghost" disabled={pxpipeActionLoading}>
                    Stop
                  </Button>
                </>
              ) : (
                <Button onClick={() => pxpipeAction("start")} disabled={pxpipeActionLoading}>
                  {pxpipeActionLoading ? "Starting…" : "Start"}
                </Button>
              )}
              <Button onClick={() => pxpipeAction("install")} variant="ghost" disabled={pxpipeActionLoading}>
                Repair
              </Button>
              <a
                href="/dashboard/pxpipe#logs"
                className="col-span-2 rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
              >
                Open Logs
              </a>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Minimum prompt size (chars)</p>
            <Input
              value={String(pxpipeMinChars)}
              onChange={(e) => setPxpipeMinChars(e.target.value)}
              onBlur={handlePxpipeMinCharsBlur}
              placeholder="25000"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Requests smaller than this bypass PXPIPE and are sent as-is.
            </p>
          </div>
          {pxpipeActionError && (
            <p className="text-sm text-warning">{pxpipeActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshPxpipeStatus().then(runPxpipeHealth)}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button onClick={() => setShowPxpipeModal(false)} fullWidth>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
