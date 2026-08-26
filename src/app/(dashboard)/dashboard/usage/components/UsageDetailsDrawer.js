"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { formatBytes } from "@/shared/utils/formatBytes";

const fmt = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);
const fmtCost = (value) => `$${Number(value || 0).toFixed(4)}`;

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function toDatetimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function StatusBadge({ status }) {
  const className = status === "error"
    ? "border-rose-500/20 bg-rose-500/10 text-rose-600"
    : status === "cancelled"
      ? "border-amber-500/20 bg-amber-500/10 text-amber-600"
      : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600";
  const label = status === "error" ? "失败" : status === "cancelled" ? "已取消" : "成功";
  return <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${className}`}>{label}</span>;
}

StatusBadge.propTypes = { status: PropTypes.string };

function Field({ label, children, className = "" }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] font-semibold text-text-muted">{label}</span>
      {children}
    </label>
  );
}

Field.propTypes = { label: PropTypes.string.isRequired, children: PropTypes.node.isRequired, className: PropTypes.string };

const controlClassName = "h-9 w-full min-w-0 rounded-lg border border-border bg-bg px-3 text-sm text-text-main outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/15";

function formatDuration(durationMs) {
  if (!durationMs) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} 秒`;
  return `${(durationMs / 60_000).toFixed(1)} 分`;
}

function FilterDropdown({ icon, title, value, options, allLabel, allIcon, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label || allLabel;

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const selectOption = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex h-9 w-full items-center gap-2 rounded-lg border px-2.5 text-left transition-all ${open ? "border-primary/60 bg-primary/[0.07] shadow-[var(--shadow-focus)]" : "border-border bg-bg hover:border-primary/40 hover:bg-bg-subtle"}`}
      >
        <span className={`material-symbols-outlined grid size-6 place-items-center rounded-md text-[16px] ${open ? "bg-primary text-white" : "bg-surface-2 text-primary"}`}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-main" title={selectedLabel}>{selectedLabel}</span>
        <span className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${open ? "rotate-180" : ""}`}>expand_more</span>
      </button>

      {open ? (
        <div role="menu" className="absolute left-0 z-[60] mt-2 w-full min-w-[260px] overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-elev)]">
          <div className="border-b border-border bg-bg-subtle/60 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">{title}</p>
            <p className="mt-0.5 text-xs text-text-muted">选择一个条件筛选使用明细</p>
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5 custom-scrollbar">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!value}
              onClick={() => selectOption("")}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${!value ? "bg-primary/10 text-primary" : "text-text-main hover:bg-bg-subtle"}`}
            >
              <span className={`material-symbols-outlined text-[18px] ${!value ? "text-primary" : "text-text-muted"}`}>{!value ? "check_circle" : allIcon}</span>
              <span className="flex-1 font-semibold">{allLabel}</span>
              {!value ? <span className="text-[10px] font-bold uppercase tracking-wide">已选择</span> : null}
            </button>
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => selectOption(option.value)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${active ? "bg-primary/10 text-primary" : "text-text-main hover:bg-bg-subtle"}`}
                >
                  <span className={`material-symbols-outlined text-[18px] ${active ? "text-primary" : "text-text-muted"}`}>{active ? "check_circle" : option.icon || icon}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold" title={option.label}>{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

FilterDropdown.propTypes = {
  icon: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  value: PropTypes.string,
  options: PropTypes.arrayOf(PropTypes.shape({ value: PropTypes.string.isRequired, label: PropTypes.string.isRequired, icon: PropTypes.string })).isRequired,
  allLabel: PropTypes.string.isRequired,
  allIcon: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};

export default function UsageDetailsDrawer({ isOpen, onClose, subject, initialFilters, filterOptions }) {
  const [draftFilters, setDraftFilters] = useState(() => ({ ...initialFilters }));
  const [filters, setFilters] = useState(() => ({ ...initialFilters }));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState({ details: [], pagination: { totalItems: 0 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDetails = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const response = await fetch(`/api/usage/details?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("请求明细加载失败");
      setData(await response.json());
    } catch (loadError) {
      setError(loadError.message || "请求明细加载失败");
      setData({ details: [], pagination: { totalItems: 0 } });
    } finally {
      setLoading(false);
    }
  }, [filters, isOpen, page, pageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => { loadDetails(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDetails]);

  const updateDraft = (key, value) => setDraftFilters((current) => ({ ...current, [key]: value }));
  const applyFilters = (event) => {
    event.preventDefault();
    setFilters({ ...draftFilters });
    setPage(1);
  };
  const resetFilters = () => {
    const rangeOnly = { startDate: initialFilters.startDate || "", endDate: initialFilters.endDate || "" };
    setDraftFilters(rangeOnly);
    setFilters(rangeOnly);
    setPage(1);
  };
  const pagination = data.pagination || { totalItems: 0 };

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={`${subject} · 使用明细`} width="3xl">
      <div className="flex min-w-0 flex-col gap-5">
        <section className="rounded-xl border border-primary/15 bg-primary/[0.045] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-text-main">同口径调用明细</p>
              <p className="mt-1 text-xs text-text-muted">默认继承看板的时间范围和点击项；调整条件后点击“应用筛选”即可重新查询。</p>
            </div>
            <span className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">共 {fmt(pagination.totalItems)} 条</span>
          </div>
        </section>

        <form onSubmit={applyFilters} className="rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <div>
              <h3 className="text-sm font-semibold text-text-main">详细筛选</h3>
              <p className="mt-0.5 text-xs text-text-muted">所有条件均使用统一的下拉菜单，点击后选择对应筛选项。</p>
            </div>
            <button type="button" onClick={resetFilters} className="text-xs font-semibold text-primary hover:underline">重置为看板时间范围</button>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="开始时间">
              <input type="datetime-local" value={toDatetimeLocal(draftFilters.startDate)} onChange={(event) => updateDraft("startDate", event.target.value ? new Date(event.target.value).toISOString() : "")} className={controlClassName} />
            </Field>
            <Field label="结束时间">
              <input type="datetime-local" value={toDatetimeLocal(draftFilters.endDate)} onChange={(event) => updateDraft("endDate", event.target.value ? new Date(event.target.value).toISOString() : "")} className={controlClassName} />
            </Field>
            <Field label="提供商">
              <FilterDropdown
                icon="dns"
                title="PROVIDER"
                value={draftFilters.provider || ""}
                options={filterOptions.providers.map((value) => ({ value, label: value, icon: "dns" }))}
                allLabel="全部提供商"
                allIcon="dns"
                onChange={(value) => updateDraft("provider", value)}
              />
            </Field>
            <Field label="模型">
              <FilterDropdown
                icon="model_training"
                title="MODEL"
                value={draftFilters.model || ""}
                options={filterOptions.models.map((value) => ({ value, label: value, icon: "model_training" }))}
                allLabel="全部模型"
                allIcon="model_training"
                onChange={(value) => updateDraft("model", value)}
              />
            </Field>
            <Field label="使用人">
              <FilterDropdown
                icon="person"
                title="API KEY PERSON"
                value={draftFilters.apiKeyId || ""}
                options={filterOptions.people.map((person) => ({ value: person.id, label: person.label, icon: "person" }))}
                allLabel="全部使用人"
                allIcon="groups"
                onChange={(value) => updateDraft("apiKeyId", value)}
              />
            </Field>
            <Field label="来源应用">
              <FilterDropdown
                icon="devices"
                title="APP SOURCE"
                value={draftFilters.appName || ""}
                options={filterOptions.apps.map((value) => ({ value, label: value, icon: "devices" }))}
                allLabel="全部应用"
                allIcon="devices"
                onChange={(value) => updateDraft("appName", value)}
              />
            </Field>
            <Field label="来源 IP">
              <FilterDropdown
                icon="lan"
                title="SOURCE IP"
                value={draftFilters.sourceIp || ""}
                options={filterOptions.sourceIps.map((value) => ({ value, label: value, icon: "lan" }))}
                allLabel="全部 IP"
                allIcon="lan"
                onChange={(value) => updateDraft("sourceIp", value)}
              />
            </Field>
            <Field label="调用状态">
              <FilterDropdown
                icon="task_alt"
                title="REQUEST STATUS"
                value={draftFilters.status || ""}
                options={[
                  { value: "success", label: "成功", icon: "check_circle" },
                  { value: "error", label: "失败", icon: "error" },
                  { value: "cancelled", label: "已取消", icon: "cancel" },
                ]}
                allLabel="全部状态"
                allIcon="filter_alt"
                onChange={(value) => updateDraft("status", value)}
              />
            </Field>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={resetFilters} className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-semibold text-text-main transition-colors hover:bg-bg-subtle">清空条件</button>
            <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-white transition-colors hover:bg-primary/90"><span className="material-symbols-outlined text-[17px]">filter_alt</span>应用筛选</button>
          </div>
        </form>

        <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1440px] border-collapse text-xs">
              <thead className="border-b border-border bg-bg-subtle/50 text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted">
                <tr>
                  <th className="px-4 py-3 text-left">调用时间</th>
                  <th className="px-4 py-3 text-left">使用人</th>
                  <th className="px-4 py-3 text-left">模型 / 提供商</th>
                  <th className="px-4 py-3 text-left">来源</th>
                  <th className="px-4 py-3 text-left">请求端点</th>
                  <th className="px-4 py-3 text-left">状态</th>
                  <th className="px-4 py-3 text-right">输入 / 输出</th>
                  <th className="px-4 py-3 text-right">总 Token</th>
                  <th className="px-4 py-3 text-right">流量 ↑ / ↓</th>
                  <th className="px-4 py-3 text-right">成本</th>
                  <th className="px-4 py-3 text-right">耗时</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {loading ? (
                  <tr><td colSpan="11" className="px-5 py-14 text-center text-sm text-text-muted"><span className="material-symbols-outlined mr-2 animate-spin align-[-4px] text-[18px]">progress_activity</span>正在读取调用明细…</td></tr>
                ) : error ? (
                  <tr><td colSpan="11" className="px-5 py-14 text-center text-sm text-rose-600">{error}</td></tr>
                ) : !data.details?.length ? (
                  <tr><td colSpan="11" className="px-5 py-14 text-center text-sm text-text-muted">当前筛选范围内没有调用记录。</td></tr>
                ) : data.details.map((detail) => (
                  <tr key={detail.id} className="transition-colors hover:bg-primary/[0.025]">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-text-muted">{formatDateTime(detail.timestamp)}</td>
                    <td className="max-w-[160px] px-4 py-3"><p className="truncate font-semibold text-text-main" title={detail.keyName}>{detail.keyName}</p></td>
                    <td className="max-w-[240px] px-4 py-3"><p className="truncate font-semibold text-text-main" title={detail.model}>{detail.model}</p><p className="mt-0.5 truncate text-[10px] text-text-muted" title={detail.provider}>{detail.provider}</p></td>
                    <td className="max-w-[220px] px-4 py-3"><p className="truncate font-medium text-text-main" title={detail.appName}>{detail.appName}</p><p className="mt-0.5 truncate font-mono text-[10px] text-text-muted" title={detail.sourceIp || "IP 未采集"}>{detail.sourceIp || "IP 未采集"}</p></td>
                    <td className="max-w-[220px] px-4 py-3 font-mono text-[11px] text-text-muted"><p className="truncate" title={detail.endpoint}>{detail.endpoint || "—"}</p></td>
                    <td className="px-4 py-3"><StatusBadge status={detail.status} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-right"><span className="text-indigo-500">{fmt(detail.promptTokens)}</span><span className="px-1 text-text-muted">/</span><span className="text-emerald-500">{fmt(detail.completionTokens)}</span></td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-primary">{fmt(detail.totalTokens)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-[10px]"><span className="text-indigo-600">{formatBytes(detail.requestBytes)}</span><span className="px-1 text-text-muted">/</span><span className="text-emerald-600">{formatBytes(detail.responseBytes)}</span><p className="mt-0.5 font-sans font-semibold text-text-main">{formatBytes(detail.totalBytes)}</p></td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-warning">{fmtCost(detail.cost)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-text-muted">{formatDuration(detail.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !error && pagination.totalItems > 0 && (
            <div className="border-t border-border px-3">
              <Pagination currentPage={page} pageSize={pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={(nextPageSize) => { setPageSize(nextPageSize); setPage(1); }} />
            </div>
          )}
        </section>
      </div>
    </Drawer>
  );
}

UsageDetailsDrawer.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  subject: PropTypes.string.isRequired,
  initialFilters: PropTypes.object.isRequired,
  filterOptions: PropTypes.shape({
    providers: PropTypes.arrayOf(PropTypes.string).isRequired,
    models: PropTypes.arrayOf(PropTypes.string).isRequired,
    people: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string.isRequired, label: PropTypes.string.isRequired })).isRequired,
    apps: PropTypes.arrayOf(PropTypes.string).isRequired,
    sourceIps: PropTypes.arrayOf(PropTypes.string).isRequired,
  }).isRequired,
};
