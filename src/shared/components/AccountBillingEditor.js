"use client";

import { useEffect, useState } from "react";
import { BILLING_MODES, BILLING_MODE_LABELS, resolveAccountBillingMode } from "@/shared/utils/accountBilling";

import { APP_TIMEZONE, formatDate, startOfDay, toDateInputValue } from "@/shared/utils/datetime";

const control = "w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40";
const today = () => toDateInputValue();
const blankEntry = () => ({ amount: "", currency: "CNY", paidAt: today(), startAt: today(), endAt: "", note: "" });
const money = (entry) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: entry.currency }).format(entry.amount);
const dateLabel = formatDate;
function isoDay(day) {
  let midnight = startOfDay(`${day}T00:00:00Z`);
  const rendered = toDateInputValue(midnight);
  if (rendered !== day) midnight = startOfDay(new Date(midnight.getTime() + (rendered < day ? 1 : -1) * 86400000));
  return midnight.toISOString();
}

/** Independently saved billing information; never mixed with OAuth expiry. */
export default function AccountBillingEditor({ connection, onChanged }) {
  const [mode, setMode] = useState(() => resolveAccountBillingMode(connection));
  const [savedMode, setSavedMode] = useState(mode);
  const [entries, setEntries] = useState([]);
  const [draft, setDraft] = useState(blankEntry);
  const [entryId, setEntryId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const id = connection?.id;

  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    fetch(`/api/providers/${encodeURIComponent(id)}/billing`, { cache: "no-store", signal: abort.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "读取订阅记录失败");
        const resolved = data.billing?.mode || resolveAccountBillingMode(connection);
        setError("");
        setMode(resolved); setSavedMode(resolved); setEntries(data.billing?.entries || []);
      })
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
    // The account id defines the editor lifetime, not the parent's render object.
  }, [id, revision]);

  const changed = () => {
    window.dispatchEvent(new CustomEvent("accountBillingChanged"));
    onChanged?.();
  };
  const saveMode = async () => {
    setBusy("mode"); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(id)}/billing`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存计费方式失败");
      setSavedMode(data.billing?.mode || mode);
      setNotice("计费方式已保存。历史 Token 记录不变。"); changed();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const addEntry = async () => {
    setError(""); setNotice("");
    if (draft.amount === "" || !Number.isFinite(Number(draft.amount)) || Number(draft.amount) < 0) {
      setError("请填写不小于 0 的实付金额。"); return;
    }
    if (!draft.paidAt || !draft.startAt || !draft.endAt || draft.startAt >= draft.endAt) {
      setError("请填写付款日期和有效期；到期日期必须晚于生效日期。"); return;
    }
    setBusy("entry");
    const requestId = entryId || crypto.randomUUID();
    setEntryId(requestId);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(id)}/billing`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, id: requestId, amount: Number(draft.amount), paidAt: isoDay(draft.paidAt), startAt: isoDay(draft.startAt), endAt: isoDay(draft.endAt) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存订阅记录失败");
      setEntries(data.billing?.entries || []); setDraft(blankEntry()); setEntryId(null);
      setNotice("订阅记录已添加，之前的续费记录已保留。"); changed();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const edit = (field, value) => { setDraft((old) => ({ ...old, [field]: value })); setEntryId(null); };
  const subscription = savedMode === "subscription" || savedMode === "hybrid";

  return (
    <section className="min-w-0 rounded-xl border border-border-subtle bg-surface p-4" aria-label="账号计费与订阅">
      <h3 className="text-sm font-semibold text-text-main">计费与订阅</h3>
      <p className="mt-1 text-xs leading-5 text-text-muted">独立保存，不随账号表单一起提交。订阅费不按 Token 计价；所有账号仍统计 Token 用量。</p>
      {loading ? <p role="status" className="mt-3 text-sm text-text-muted">正在读取订阅记录…</p> : <>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-40 flex-1 text-xs text-text-muted">计费方式
            <select aria-label="账号计费方式" className={`${control} mt-1`} value={mode} disabled={Boolean(busy)} onChange={(e) => setMode(e.target.value)}>
              {BILLING_MODES.map((value) => <option key={value} value={value}>{BILLING_MODE_LABELS[value]}</option>)}
            </select>
          </label>
          <button type="button" className="rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main hover:bg-surface-2 disabled:opacity-50" onClick={saveMode} disabled={Boolean(busy) || mode === savedMode}>{busy === "mode" ? "保存中…" : "保存计费方式"}</button>
        </div>
        {mode !== savedMode && <p className="mt-2 text-xs text-text-muted">先保存计费方式，再录入订阅费用。</p>}
        {savedMode === "unknown" && <p className="mt-2 text-xs text-text-muted">请选择实际计费方式；未知计费不作为免费，也不计入按量费用合计。</p>}
        {savedMode === "hybrid" && <p className="mt-2 text-xs text-text-muted">固定订阅费与按量预估分列；不能据此判断哪些 Token 属于超额付费，也不会将两项直接相加。</p>}
        {subscription && <div className="mt-4 border-t border-border-subtle pt-3">
          <h4 className="text-sm font-medium text-text-main">新增购买 / 续费</h4>
          <p className="mt-1 text-xs leading-5 text-text-muted">填写实际付款，不自动续费。有效期为生效日零点至到期日零点（不含到期日，{APP_TIMEZONE}），与登录凭据有效期无关。</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-xs text-text-muted">实付金额<input aria-label="订阅实付金额" type="number" min="0" step="0.01" className={`${control} mt-1`} value={draft.amount} onChange={(e) => edit("amount", e.target.value)} /></label>
            <label className="text-xs text-text-muted">币种<select aria-label="订阅币种" className={`${control} mt-1`} value={draft.currency} onChange={(e) => edit("currency", e.target.value)}><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option><option value="EUR">EUR 欧元</option><option value="HKD">HKD 港币</option><option value="JPY">JPY 日元</option></select></label>
            {[ ["paidAt", "付款日期"], ["startAt", "生效日期"], ["endAt", "到期日期"] ].map(([field, label]) => <label key={field} className="min-w-0 text-xs text-text-muted">{label}<input aria-label={`订阅${label}`} type="date" className={`${control} mt-1`} value={draft[field]} onChange={(e) => edit(field, e.target.value)} /></label>)}
            <label className="text-xs text-text-muted">套餐 / 备注<input aria-label="订阅备注" className={`${control} mt-1`} maxLength={500} value={draft.note} onChange={(e) => edit("note", e.target.value)} placeholder="例如：月付套餐" /></label>
          </div>
          <button type="button" className="mt-3 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={Boolean(busy) || mode !== savedMode} onClick={addEntry}>{busy === "entry" ? "保存中…" : "添加订阅记录"}</button>
        </div>}
        <div className="mt-4 border-t border-border-subtle pt-3">
          <h4 className="text-xs font-medium text-text-main">订阅记录（{entries.length}）</h4>
          {!entries.length ? <p className="mt-2 text-xs text-text-muted">尚未录入费用。未录入不代表零成本。</p> : <ul className="mt-2 max-h-56 divide-y divide-border-subtle overflow-y-auto">
            {[...entries].sort((a, b) => b.startAt.localeCompare(a.startAt)).map((entry) => <li key={entry.id} className="py-2 text-xs text-text-muted">
              <div className="flex flex-wrap justify-between gap-2"><span className="font-medium tabular-nums text-text-main">{money(entry)}</span><span>{dateLabel(entry.startAt)} 至 {dateLabel(entry.endAt)}</span></div>
              <p className="mt-1">付款 {dateLabel(entry.paidAt)}{entry.note ? ` · ${entry.note}` : ""}</p>
            </li>)}
          </ul>}
        </div>
      </>}
      {error && <div role="alert" className="mt-3 text-sm text-red-500">{error} <button type="button" className="underline" onClick={() => setRevision((n) => n + 1)}>重新读取</button></div>}
      {notice && <p role="status" className="mt-3 text-xs text-text-muted">{notice}</p>}
    </section>
  );
}
