"use client";

import { Fragment, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import AccountBillingEditor from "@/shared/components/AccountBillingEditor";
import { APP_TIMEZONE, formatDateTime } from "@/shared/utils/datetime";

const MODES = {
  subscription: "订阅",
  metered: "按量",
  hybrid: "订阅 + 按量",
  free: "免费",
  unknown: "未设置",
};
const TOKEN_COLUMNS = [
  ["requests", "请求"],
  ["inputTokens", "输入"],
  ["outputTokens", "输出"],
  ["cachedTokens", "缓存命中"],
  ["cacheCreationTokens", "缓存写入"],
  ["totalTokens", "总 Token"],
];
const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const amountFormat = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const controlClass = "rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-main focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current";
const numericCell = "whitespace-nowrap px-3 py-3 text-right tabular-nums";

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function quantity(value) {
  return numberFormat.format(numeric(value));
}

function tokenValue(row, field) {
  // Cache reads/writes are subsets of input, never extra tokens to add again.
  return field === "totalTokens"
    ? numeric(row.inputTokens) + numeric(row.outputTokens)
    : numeric(row[field]);
}

function modeOf(account) {
  return Object.hasOwn(MODES, account.billingMode) ? account.billingMode : "unknown";
}

function identityOf(account) {
  return account.id || `unattributed:${account.provider || "unknown"}:${account.name || ""}`;
}

function money(value, currency = "USD") {
  return `${currency} ${amountFormat.format(numeric(value))}`;
}

function usdEstimate(value) {
  return numeric(typeof value === "object" && value !== null ? value.USD : value);
}

function CurrencyAmounts({ amounts }) {
  const entries = Object.entries(amounts || {}).filter(([, amount]) => Number.isFinite(Number(amount)));
  if (entries.length === 0) return <span className="text-text-muted">—</span>;
  return (
    <span className="inline-flex flex-col items-end gap-1 tabular-nums">
      {entries.sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => (
        <span className="whitespace-nowrap" key={currency}>{money(amount, currency)}</span>
      ))}
    </span>
  );
}

function timestamp(value) {
  if (value === undefined || value === null || value === "") return NaN;
  return new Date(value).getTime();
}

function expiryDescription(entries, now) {
  const currentPeriods = (entries || []).filter((entry) => {
    const start = timestamp(entry.startAt);
    const end = timestamp(entry.endAt);
    return Number.isFinite(start) && start <= now && Number.isFinite(end) && end > start;
  });
  if (currentPeriods.length === 0) return null;
  const end = Math.max(...currentPeriods.map((entry) => timestamp(entry.endAt)));
  const date = formatDateTime(end);
  if (end <= now) return `已到期：${date}`;
  if (end - now <= 7 * 24 * 60 * 60 * 1000) return `即将到期：${date}`;
  return `到期：${date}`;
}

function summarize(accounts) {
  const totals = { subscriptionPaid: {}, subscriptionAccrued: {}, meteredEstimate: 0, unknownEstimate: 0, unpricedRequests: 0 };
  for (const account of accounts) {
    for (const [field] of TOKEN_COLUMNS) totals[field] = numeric(totals[field]) + tokenValue(account, field);
    totals.meteredEstimate += usdEstimate(account.meteredEstimate);
    totals.unknownEstimate += usdEstimate(account.unknownEstimate);
    totals.unpricedRequests += numeric(account.unpricedRequests);
    for (const field of ["subscriptionPaid", "subscriptionAccrued"]) {
      for (const [currency, amount] of Object.entries(account[field] || {})) {
        totals[field][currency] = numeric(totals[field][currency]) + numeric(amount);
      }
    }
  }
  return totals;
}

function TokenBreakdown({ rows, dimension, dayTimezone = "UTC" }) {
  const sorted = [...rows].sort((a, b) => dimension === "date"
    ? String(b.date).localeCompare(String(a.date))
    : tokenValue(b, "totalTokens") - tokenValue(a, "totalTokens"));
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{dimension === "date" ? "账号按日期用量" : "账号按模型用量"}</caption>
      <thead className="border-b border-border-subtle text-text-muted">
        <tr>
          <th scope="col" className="px-3 py-2 text-left font-medium">{dimension === "date" ? `日期（${dayTimezone}）` : "模型"}</th>
          {TOKEN_COLUMNS.map(([field, label]) => <th scope="col" className="px-3 py-2 text-right font-medium" key={field}>{label}</th>)}
        </tr>
      </thead>
      <tbody className="divide-y divide-border-subtle">
        {sorted.map((row, index) => (
          <tr key={`${row[dimension]}-${index}`}>
            <th scope="row" className="max-w-80 break-words px-3 py-2 text-left font-normal">{row[dimension] || "未记录"}</th>
            {TOKEN_COLUMNS.map(([field]) => <td key={field} className={numericCell}>{quantity(tokenValue(row, field))}</td>)}
          </tr>
        ))}
        {sorted.length === 0 && <tr><td colSpan={7} className="px-3 py-5 text-center text-text-muted">所选期间暂无明细。</td></tr>}
      </tbody>
    </table>
  );
}

function SubscriptionLedger({ entries }) {
  const sorted = [...entries].sort((a, b) => (timestamp(b.paidAt) || 0) - (timestamp(a.paidAt) || 0));
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">订阅付款与服务期间记录</caption>
      <thead className="border-b border-border-subtle text-text-muted">
        <tr>
          {["付款日期", "实付金额", "期间开始", "期间结束", "备注"].map((label) => (
            <th scope="col" key={label} className={`px-3 py-2 font-medium ${label === "实付金额" ? "text-right" : "text-left"}`}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border-subtle">
        {sorted.map((entry, index) => (
          <tr key={entry.id || index}>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatDateTime(entry.paidAt)}</td>
            <td className={numericCell}>{entry.currency ? money(entry.amount, entry.currency) : `${amountFormat.format(numeric(entry.amount))}（币种未记录）`}</td>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatDateTime(entry.startAt)}</td>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatDateTime(entry.endAt)}</td>
            <td className="min-w-48 max-w-96 break-words px-3 py-3">{entry.note || "—"}</td>
          </tr>
        ))}
        {sorted.length === 0 && <tr><td colSpan={5} className="px-3 py-5 text-center text-text-muted">暂无订阅记录。没有记录不代表免费，可在下方补录。</td></tr>}
      </tbody>
    </table>
  );
}

function AccountDetails({ account, onChanged, dayTimezone }) {
  const [view, setView] = useState("ledger");
  const sections = [
    ["ledger", "订阅记录"],
    ...(Array.isArray(account.models) ? [["models", "按模型"]] : []),
    ...(Array.isArray(account.days) ? [["days", "按日期"]] : []),
  ];
  return (
    <div className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="账号明细视图">
          {sections.map(([key, label]) => (
            <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)} className={`${controlClass} ${view === key ? "font-semibold underline underline-offset-4" : "text-text-muted"}`}>{label}</button>
          ))}
        </div>
        {account.provider && !account.deleted && (
          <Link className="rounded text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2" href={`/dashboard/providers?channel=${encodeURIComponent(account.provider)}`}>管理账号</Link>
        )}
      </div>
      <div className="max-w-full overflow-x-auto rounded-lg border border-border-subtle" role="region" aria-label={`${account.name || account.id}的明细表`} tabIndex={0}>
        {view === "ledger" && <SubscriptionLedger entries={Array.isArray(account.entries) ? account.entries : []} />}
        {view === "models" && <TokenBreakdown rows={account.models || []} dimension="model" />}
        {view === "days" && <TokenBreakdown rows={account.days || []} dimension="date" dayTimezone={account.dayTimezone || dayTimezone || "UTC"} />}
      </div>
      <div className="max-w-4xl space-y-1 text-xs leading-relaxed text-text-muted">
        <p>总 Token = 输入 + 输出。缓存命中与缓存写入是输入的子集，不再重复相加；未上报的缓存字段可能为 0。</p>
        <p>订阅实付按付款时间统计；订阅期间分摊按服务期间与所选时间的重叠计算，不代表再次付款。不同币种分别列示，不做汇率换算。</p>
        <p>按量预估仅为 USD 定价估算，非实际账单，不与订阅实付或分摊相加。未来才开始的订阅不用于判断当前到期时间。</p>
      </div>
      {account.deleted || !account.id ? (
        <p className="text-sm text-text-muted">账号已删除，仅保留历史用量与订阅账本快照，无法编辑。</p>
      ) : (
        <AccountBillingEditor connection={{ ...account, id: account.id }} onChanged={onChanged} />
      )}
    </div>
  );
}

/** Account-level accounting is intentionally independent of caller/API-key scope. */
export default function AccountCostsPanel({ timeRange, apiKeyId, onBillingChanged } = {}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("all");
  const [sort, setSort] = useState("tokens-desc");
  const [expanded, setExpanded] = useState(new Set());
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ key: null, data: null, error: "", loading: true, fetchedAt: null });
  const params = new URLSearchParams();
  if (timeRange?.startDate) params.set("start", timeRange.startDate);
  // UsageTimeFilter uses an inclusive end-of-day millisecond; the accounting
  // endpoint uses a half-open interval, so include that final millisecond too.
  if (timeRange?.endDate) params.set("end", new Date(new Date(timeRange.endDate).getTime() + 1).toISOString());
  const query = params.toString();
  const requestKey = `${query}:${revision}`;

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("accountBillingChanged", refresh);
    return () => window.removeEventListener("accountBillingChanged", refresh);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/account-costs${query ? `?${query}` : ""}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok || data?.error) throw new Error(typeof data?.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`);
        if (!Array.isArray(data?.accounts)) throw new Error("账号成本响应格式不正确");
        if (!controller.signal.aborted) setState({ key: requestKey, data, error: "", loading: false, fetchedAt: Date.now() });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key: requestKey, data: null, error: error.message || "无法加载账号成本", loading: false, fetchedAt: null });
      }
    }
    void load();
    return () => controller.abort();
  }, [query, requestKey]);

  // A changed range/refresh never renders the previous range's figures while loading.
  const loading = state.key !== requestKey || state.loading;
  const data = !loading ? state.data : null;
  const error = !loading ? state.error : "";
  const accounts = useMemo(() => data?.accounts || [], [data]);
  const totals = useMemo(() => ({ ...summarize(accounts), ...data?.totals }), [accounts, data]);
  const visibleAccounts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-CN");
    return accounts.filter((account) => {
      const matchesText = [account.name, account.provider, account.id].some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(term));
      return matchesText && (mode === "all" || modeOf(account) === mode);
    }).sort((a, b) => {
      const byName = String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
      if (sort === "name") return byName;
      if (sort === "requests-desc") return numeric(b.requests) - numeric(a.requests) || byName;
      const difference = tokenValue(b, "totalTokens") - tokenValue(a, "totalTokens");
      return (sort === "tokens-asc" ? -difference : difference) || byName;
    });
  }, [accounts, mode, search, sort]);

  function toggleAccount(accountId) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function billingChanged(...args) {
    setRevision((value) => value + 1);
    onBillingChanged?.(...args);
  }

  const summary = [
    { label: "总 Token", value: quantity(tokenValue(totals, "totalTokens")), detail: `${quantity(totals.requests)} 次请求 · 输入 + 输出` },
    { label: "订阅实付", value: <CurrencyAmounts amounts={totals.subscriptionPaid} />, detail: "所选期间内的付款，按币种分别列示" },
    { label: "订阅期间分摊", value: <CurrencyAmounts amounts={totals.subscriptionAccrued} />, detail: "服务期间与所选时间重叠的分摊，非新增付款" },
    { label: "按量预估", value: money(usdEstimate(totals.meteredEstimate)), detail: "仅 USD 估算，非实际账单，不与订阅相加" },
  ];

  return (
    <section aria-labelledby={`${id}-heading`} aria-busy={loading} className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border-subtle bg-surface text-text-main">
      <header className="space-y-3 px-4 pt-5 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id={`${id}-heading`} className="text-lg font-semibold">账号用量与成本</h2>
            <p className="mt-1 max-w-4xl text-sm leading-relaxed text-text-muted">Token 用量与费用独立统计：用量不等于实付，订阅付款、期间分摊与按量预估分开核对。包含零用量账号及已删除账号的历史账本。</p>
          </div>
          <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading} className={`${controlClass} shrink-0 disabled:opacity-50`}>刷新</button>
        </div>
        {apiKeyId && (
          <p role="note" className="rounded-lg border border-border-subtle px-3 py-2 text-sm leading-relaxed">此处显示所有调用方的账号成本，不受上方 API Key 筛选影响；所选时间范围仍然有效。订阅费用无法归属到单个 API Key。</p>
        )}
        <p className="text-xs text-text-muted">{timeRange?.startDate ? formatDateTime(timeRange.startDate) : "全部已记录时间"}{timeRange?.endDate ? ` 至 ${formatDateTime(timeRange.endDate)}` : ""}（{APP_TIMEZONE}）</p>
      </header>

      {loading ? (
        <p role="status" className="px-5 py-12 text-center text-sm text-text-muted">正在加载账号用量与成本…</p>
      ) : error ? (
        <div role="alert" className="space-y-3 px-5 py-8">
          <p className="text-sm">加载失败：{error}</p>
          <button type="button" className={controlClass} onClick={() => setRevision((value) => value + 1)}>重试</button>
        </div>
      ) : (
        <>
          <dl className="mx-4 my-5 grid grid-cols-1 divide-y divide-border-subtle rounded-lg border border-border-subtle sm:mx-5 sm:grid-cols-2 xl:grid-cols-4">
            {summary.map((item) => (
              <div key={item.label} className="min-w-0 px-4 py-4">
                <dt className="text-xs text-text-muted">{item.label}</dt>
                <dd className="mt-2 flex flex-wrap justify-end break-all text-right text-xl font-semibold tabular-nums">{item.value}</dd>
                <dd className="mt-2 text-xs leading-relaxed text-text-muted">{item.detail}</dd>
              </div>
            ))}
          </dl>
          {numeric(totals.unpricedRequests) > 0 && (
            <p role="note" className="mx-4 mb-4 rounded-lg border border-border-subtle px-3 py-2 text-sm sm:mx-5">注意：{quantity(totals.unpricedRequests)} 次请求缺少定价，按量预估不完整；未知费用不代表免费。</p>
          )}
          {usdEstimate(totals.unknownEstimate) > 0 && <p className="mx-4 mb-4 text-xs text-text-muted sm:mx-5">未设置计费方式账号的 Token 定价参考：{money(usdEstimate(totals.unknownEstimate))}，未计入按量预估，不代表实际费用。</p>}
          <div className="flex flex-wrap items-end gap-3 px-4 pb-4 sm:px-5">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-text-muted" htmlFor={`${id}-search`}>
              搜索账号或渠道
              <input id={`${id}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="账号名、渠道或 ID" className={`${controlClass} w-full min-w-40`} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted" htmlFor={`${id}-mode`}>
              计费方式
              <select id={`${id}-mode`} value={mode} onChange={(event) => setMode(event.target.value)} className={controlClass}>
                <option value="all">全部方式</option>
                {Object.entries(MODES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted" htmlFor={`${id}-sort`}>
              排序
              <select id={`${id}-sort`} value={sort} onChange={(event) => setSort(event.target.value)} className={controlClass}>
                <option value="tokens-desc">总 Token 从多到少</option>
                <option value="tokens-asc">总 Token 从少到多</option>
                <option value="requests-desc">请求从多到少</option>
                <option value="name">账号名称</option>
              </select>
            </label>
          </div>
          <p className="px-4 pb-3 text-xs text-text-muted sm:px-5" aria-live="polite">显示 {quantity(visibleAccounts.length)} / {quantity(accounts.length)} 个账号；上方汇总为所有账号，不随搜索和计费方式筛选变化。窄屏可在表格内横向滚动。</p>
          <div className="max-w-full overflow-x-auto border-y border-border-subtle focus-visible:outline-2 focus-visible:outline-offset-[-2px]" role="region" aria-label="账号成本明细，支持横向滚动" tabIndex={0}>
            <table className="w-full min-w-[1240px] text-sm">
              <caption className="sr-only">账号用量与成本：总 Token 为输入加输出，缓存不重复计算，费用按币种分别列示</caption>
              <thead className="border-b border-border-subtle text-xs text-text-muted">
                <tr>
                  <th scope="col" className="min-w-64 px-4 py-3 text-left font-medium">账号</th>
                  <th scope="col" className="px-3 py-3 text-left font-medium">计费方式</th>
                  {TOKEN_COLUMNS.map(([field, label]) => <th scope="col" key={field} className="whitespace-nowrap px-3 py-3 text-right font-medium">{label}</th>)}
                  <th scope="col" className="whitespace-nowrap px-3 py-3 text-right font-medium">订阅分摊</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-3 text-right font-medium">按量预估</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {visibleAccounts.map((account) => {
                  const identity = identityOf(account);
                  const isExpanded = expanded.has(identity);
                  const detailsId = `${id}-details-${encodeURIComponent(identity)}`;
                  const expiry = expiryDescription(account.entries, state.fetchedAt);
                  return (
                    <Fragment key={identity}>
                      <tr>
                        <th scope="row" className="max-w-80 px-4 py-3 text-left font-normal">
                          <button type="button" aria-expanded={isExpanded} aria-controls={isExpanded ? detailsId : undefined} onClick={() => toggleAccount(identity)} className="flex max-w-full items-start gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-4">
                            <span aria-hidden="true" className="shrink-0 text-text-muted">{isExpanded ? "−" : "+"}</span>
                            <span className="min-w-0 break-words font-medium">{account.name || account.id}<span className="sr-only">的明细</span></span>
                          </button>
                          <div className="mt-1 break-words pl-5 text-xs text-text-muted">{account.provider || "渠道未记录"}{account.deleted ? " · 已删除（历史快照）" : ""}</div>
                          {expiry && <p className="mt-1 pl-5 text-xs text-text-muted">{expiry}</p>}
                        </th>
                        <td className="px-3 py-3">
                          <span className="whitespace-nowrap">{MODES[modeOf(account)]}</span>
                          {modeOf(account) === "unknown" && <p className="mt-1 text-xs text-text-muted">费用未知，非免费</p>}
                          {account.billingWarning && <p className="mt-1 max-w-56 text-xs text-text-muted">{account.billingWarning}</p>}
                          {numeric(account.unpricedRequests) > 0 && <p className="mt-1 text-xs text-text-muted">缺定价：{quantity(account.unpricedRequests)} 次</p>}
                        </td>
                        {TOKEN_COLUMNS.map(([field]) => <td key={field} className={`${numericCell} ${field === "totalTokens" ? "font-semibold" : ""}`}>{quantity(tokenValue(account, field))}</td>)}
                        <td className={numericCell}><CurrencyAmounts amounts={account.subscriptionAccrued} /></td>
                        <td className={numericCell}>
                          {["metered", "hybrid"].includes(modeOf(account)) ? (
                            <>{usdEstimate(account.meteredEstimate) === 0 && numeric(account.unpricedRequests) > 0 ? "未知" : money(usdEstimate(account.meteredEstimate))}{numeric(account.unpricedRequests) > 0 && <span className="mt-1 block text-xs text-text-muted">预估不完整</span>}</>
                          ) : modeOf(account) === "unknown" ? (
                            <span className="text-text-muted">未配置{usdEstimate(account.unknownEstimate) > 0 && <span className="mt-1 block text-xs">参考 {money(usdEstimate(account.unknownEstimate))}<br />未计入按量预估</span>}</span>
                          ) : <span className="text-text-muted">—（不适用）</span>}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr id={detailsId}>
                          <td colSpan={10}><AccountDetails account={account} onChanged={billingChanged} dayTimezone={data?.dayTimezone || "UTC"} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {visibleAccounts.length === 0 && (
                  <tr><td colSpan={10} className="px-5 py-10 text-center text-text-muted">{accounts.length === 0 ? "暂无账号或历史账本。添加账号后即可在此核对用量与成本。" : "没有符合筛选的账号，请调整搜索或计费方式。"}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <footer className="space-y-1 px-4 py-4 text-xs leading-relaxed text-text-muted sm:px-5">
            <p>总 Token = 输入 + 输出；缓存命中和缓存写入已含在输入中，不重复累加。费用按原币种列示，USD 按量预估不代表实际扣款。</p>
            <p>到期时间取已开始的订阅期间中最晚结束时间，未来期间不计入；展开账号可查看付款与服务期间。</p>
          </footer>
        </>
      )}
    </section>
  );
}
