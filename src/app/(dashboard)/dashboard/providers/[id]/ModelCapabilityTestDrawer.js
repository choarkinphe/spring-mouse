"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer, Button } from "@/shared/components";
import { CAPABILITY_TESTS, QUICK_CAPABILITY_TESTS, CAPABILITY_STATUS_LABELS, CAPABILITY_TEST_LIMITS } from "@/shared/constants/capabilityTests";

const tone = { supported: "text-green-500", unsupported: "text-red-500", unknown: "text-amber-500", untested: "text-text-muted" };
const valueLabel = (value) => typeof value === "boolean" ? value ? "支持" : "不支持" : typeof value === "number" ? value.toLocaleString() : "—";

export default function ModelCapabilityTestDrawer({ model, providerId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [connectionId, setConnectionId] = useState("");
  const [mode, setMode] = useState("quick");
  const [tests, setTests] = useState(QUICK_CAPABILITY_TESTS);
  const [contextTokens, setContextTokens] = useState(CAPABILITY_TEST_LIMITS.deepContextTokens);
  const [totalInputTokens, setTotalInputTokens] = useState(CAPABILITY_TEST_LIMITS.totalInputTokens);
  const [maxRequests, setMaxRequests] = useState(CAPABILITY_TEST_LIMITS.maxRequests);
  const [timeoutMs, setTimeoutMs] = useState(CAPABILITY_TEST_LIMITS.timeoutMs);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/models/capability-tests?${new URLSearchParams({ providerId, modelId: model.id })}`, { cache: "no-store" });
    const next = await res.json();
    if (!res.ok) throw new Error(next.error || "读取能力档案失败");
    setData(next);
    setConnectionId((current) => current || next.connections.find((item) => item.isActive)?.id || "");
  }, [providerId, model.id]);
  useEffect(() => {
    Promise.resolve().then(load).catch((err) => setError(err.message));
    return () => abortRef.current?.abort();
  }, [load]);
  const profile = data?.profiles.find((item) => item.connectionId === connectionId);
  const shown = report || profile?.running?.report || profile?.latest;
  const busy = running || Boolean(profile?.running);

  const start = async () => {
    if (busy || !connectionId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setError(""); setReport(null); setProgress("正在启动固定账号测试…");
    let complete = false;
    try {
      const res = await fetch("/api/models/capability-tests", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ providerId, modelId: model.id, connectionId, mode, tests, contextTokens: mode === "deep" ? Number(contextTokens) : CAPABILITY_TEST_LIMITS.quickContextTokens, totalInputTokens: Number(totalInputTokens), maxRequests: Number(maxRequests), timeoutMs: Number(timeoutMs) }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "无法启动测试");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const consume = (line) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "started") setReport(event.report);
        if (event.type === "progress") setProgress(`正在测试 ${CAPABILITY_TESTS.find((item) => item.key === event.key)?.label || event.key} · 请求 ${event.request}${event.targetTokens ? ` · 目标约 ${event.targetTokens.toLocaleString()} Token` : ""}`);
        if (event.type === "result") setReport((current) => current ? { ...current, results: { ...current.results, [event.key]: event.result }, requests: event.requests, inputTokens: event.inputTokens } : current);
        if (event.type === "complete") { complete = true; setReport(event.report); setProgress("结果已保存到本地 SQLite，可靠证据自动参与路由"); }
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n"); pending = lines.pop();
          lines.forEach(consume);
        }
        consume(pending + decoder.decode());
      } finally { reader.releaseLock(); }
      if (!complete) throw new Error("测试连接中断，未收到最终报告；已完成项目可从本地档案查询");
    } catch (err) {
      if (controller.signal.aborted) setProgress("已请求取消；已完成项目会保留到本地档案");
      else setError(err.message);
    } finally {
      setRunning(false); abortRef.current = null;
      await load().catch(() => {});
      onChanged?.();
    }
  };
  const clear = async () => {
    if (!window.confirm("清除此账号模型的实测报告和路由证据？手动能力配置不会改变。")) return;
    try {
      const res = await fetch("/api/models/capability-tests", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId, modelId: model.id, connectionId }) });
      if (!res.ok) throw new Error((await res.json()).error);
      setReport(null); await load(); onChanged?.();
    } catch (err) { setError(err.message); }
  };
  const close = () => { abortRef.current?.abort(); onClose(); };
  const inputClass = "mt-1 w-full rounded-lg border border-border-subtle bg-bg px-3 py-2 text-sm text-text-main";
  return (
    <Drawer isOpen onClose={close} title="模型能力实验室" width="xl" zIndex="z-[70]" footer={<>
      {running && <Button variant="secondary" onClick={() => abortRef.current?.abort()}>取消测试</Button>}
      <Button onClick={start} disabled={busy || !connectionId || !tests.length}>{busy ? "测试进行中" : mode === "deep" ? "开始上下文深测" : "开始能力测试"}</Button>
    </>}>
      <div className="space-y-6" role="region" aria-label="模型能力测试">
        <div className="border-b border-border-subtle pb-4">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">实测证据 · 本地档案</p>
          <h3 className="mt-2 break-all font-mono text-lg font-semibold text-text-main">{model.id}</h3>
          <p className="mt-2 text-xs leading-5 text-text-muted">固定渠道与账号测试网关可用能力，不推测模型真实身份。手动配置优先；临时失败不覆盖已有可靠证据。</p>
        </div>
        <label className="block text-xs text-text-muted">测试账号
          <select aria-label="测试账号" className={inputClass} value={connectionId} disabled={busy} onChange={(event) => { setConnectionId(event.target.value); setReport(null); }}>
            <option value="">请选择可用账号</option>
            {data?.connections.map((item) => <option key={item.id} value={item.id} disabled={!item.isActive}>{item.name}{!item.isActive ? "（停用）" : ""}</option>)}
          </select>
        </label>
        <div className="flex gap-2" role="group" aria-label="测试模式">
          {[ ["quick", "快速 / 专项测试"], ["deep", "长上下文深测"] ].map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} onClick={() => setMode(value)} className={`rounded-lg border px-4 py-2 text-sm ${mode === value ? "border-primary bg-primary/10 text-primary" : "border-border-subtle text-text-muted"}`}>{label}</button>)}
        </div>
        {mode === "quick" ? <fieldset disabled={busy} className="grid grid-cols-2 gap-x-4 gap-y-3">
          <legend className="mb-3 text-xs font-semibold text-text-main">验证项目</legend>
          {CAPABILITY_TESTS.map((item) => <label key={item.key} className="flex items-center gap-2 text-xs text-text-main"><input type="checkbox" checked={tests.includes(item.key)} onChange={(event) => setTests((current) => event.target.checked ? [...current, item.key] : current.filter((key) => key !== item.key))} />{item.label}</label>)}
        </fieldset> : <label className="block text-xs text-text-muted">单次目标上限（估算 Token）<input aria-label="上下文目标上限" type="number" min="1024" max={CAPABILITY_TEST_LIMITS.maxContextTokens} value={contextTokens} disabled={busy} onChange={(event) => setContextTokens(event.target.value)} className={inputClass} /></label>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[ ["累计 Token 预算", totalInputTokens, setTotalInputTokens, 1024, CAPABILITY_TEST_LIMITS.hardTotalInputTokens], ["最多请求次数", maxRequests, setMaxRequests, 1, CAPABILITY_TEST_LIMITS.hardMaxRequests], ["单次超时（毫秒）", timeoutMs, setTimeoutMs, 5000, CAPABILITY_TEST_LIMITS.maxTimeoutMs] ].map(([label, value, setter, min, max]) => <label key={label} className="text-xs text-text-muted">{label}<input aria-label={label} type="number" min={min} max={max} value={value} disabled={busy} onChange={(event) => setter(event.target.value)} className={inputClass} /></label>)}
        </div>
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">会消耗真实上游额度。{mode === "quick" ? `已选 ${tests.length} 项，` : "阶梯探测，"}最多 {maxRequests} 次请求，每次输出上限 {CAPABILITY_TEST_LIMITS.outputTokens} Token。Token 预算是估算护栏，不保证账单；媒体生成费用不能换算成此 Token 预算。未适配的协议路径会显示“未能确认”，不发无效测试。</p>
        {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}
        {progress && <p role="status" className="text-xs text-primary">{progress}</p>}
        {shown && <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-text-main">能力证据</h4>
            <span className="text-xs text-text-muted">{shown.protocol} · {shown.status} · {new Date(shown.completedAt || shown.startedAt).toLocaleString()}</span>
          </div>
          {profile?.stale && !running && <p className="text-xs text-amber-500">无当前有效证据（配置变化、有效期届满或结果未知）；旧报告仅供参考。</p>}
          <div className="overflow-x-auto rounded-lg border border-border-subtle">
            <table className="w-full text-left text-xs">
              <thead className="bg-sidebar text-text-muted"><tr><th className="px-3 py-2">能力</th><th className="px-3 py-2">声明 / 配置</th><th className="px-3 py-2">本次实测</th><th className="px-3 py-2">当前生效</th></tr></thead>
              <tbody className="divide-y divide-border-subtle">{CAPABILITY_TESTS.map((test) => {
                const result = shown.results[test.key] || { status: "untested" };
                return <tr key={test.key}><td className="px-3 py-3 align-top text-text-main">{test.label}</td><td className="px-3 py-3 align-top text-text-muted">{valueLabel(shown.declared?.[test.key])}</td><td className="max-w-72 px-3 py-3"><span className={`font-medium ${tone[result.status]}`}>{CAPABILITY_STATUS_LABELS[result.status]}</span><p className="mt-1 break-words leading-5 text-text-muted">{result.reason}</p>{result.context?.verifiedRetrievalTokens > 0 && <p className="mt-1 text-primary">已验证 ≥ {result.context.verifiedRetrievalTokens.toLocaleString()} Token（{(result.context.verifiedTokenSource || result.context.tokenSource) === "upstream" ? "上游用量" : "估算"}，不是最大值）</p>}{result.context?.explicitLimit && <p className="mt-1 text-text-muted">上游明确限制：{result.context.explicitLimit.toLocaleString()}（{result.context.limitKind}）</p>}{result.evidence && <details className="mt-1"><summary className="cursor-pointer text-text-muted">查看证据</summary><pre className="mt-1 whitespace-pre-wrap break-all rounded bg-sidebar p-2 text-[10px] text-text-muted">{result.evidence}</pre></details>}</td><td className="px-3 py-3 align-top text-text-main">{valueLabel(profile?.effective?.[test.key] ?? data?.effective?.[test.key])}</td></tr>;
              })}</tbody>
            </table>
          </div>
          <p className="text-xs text-text-muted">请求 {shown.requests} 次 · 输入约 {(shown.inputTokens || 0).toLocaleString()} Token · 已完成结果独立保存。跨次有效证据以当前档案为准，未知结果不会清除先前实测。最大输出声明：{valueLabel(shown.declared?.maxOutput)}；未探测绝对输出上限。</p>
          {profile?.history?.length > 0 && <details><summary className="cursor-pointer text-xs text-text-muted">最近报告（{profile.history.length}）</summary><div className="mt-2 flex flex-col gap-1">{profile.history.map((entry) => <button key={entry.runId} type="button" disabled={busy} onClick={() => setReport(entry)} className="rounded px-2 py-1 text-left text-xs text-text-muted hover:bg-sidebar">{new Date(entry.completedAt || entry.startedAt).toLocaleString()} · {entry.options.mode} · {entry.status}</button>)}</div></details>}
          <button type="button" disabled={busy} onClick={clear} className="text-xs text-red-500 disabled:opacity-40">清除此账号的实测档案</button>
        </section>}
        {!shown && !running && <p className="py-6 text-center text-sm text-text-muted">尚未测试。声明能力不是实测能力。</p>}
      </div>
    </Drawer>
  );
}
