"use client";

import PropTypes from "prop-types";
import { useEffect, useMemo, useRef, useState } from "react";

const PRESETS = [
  { value: "today", label: "今天" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
];

function atStartOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function atEndOfDay(date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function startOfWeek(date) {
  const result = atStartOfDay(date);
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return result;
}

function toInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toChineseDate(date) {
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月${String(date.getDate()).padStart(2, "0")}日`;
}

function getRange(preset, anchor) {
  const today = atEndOfDay(new Date());
  const anchorDay = atStartOfDay(anchor);

  if (preset === "week") {
    const start = startOfWeek(anchorDay);
    const end = atEndOfDay(new Date(start));
    end.setDate(end.getDate() + 6);
    return { start, end: end > today ? today : end };
  }

  if (preset === "month") {
    const start = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), 1);
    const end = new Date(anchorDay.getFullYear(), anchorDay.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end: end > today ? today : end };
  }

  return { start: anchorDay, end: atEndOfDay(anchorDay) };
}

function shiftAnchor(anchor, preset, direction) {
  const next = new Date(anchor);
  if (preset === "week") next.setDate(next.getDate() + direction * 7);
  else if (preset === "month") next.setMonth(next.getMonth() + direction);
  else next.setDate(next.getDate() + direction);
  return next;
}

function PersonFilterDropdown({ apiKeys, value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = apiKeys.find((key) => key.id === value);
  const selectedLabel = selected?.name || "全部使用人";

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

  const selectPerson = (nextValue) => {
    onChange?.(nextValue);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative min-w-[236px]">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex h-10 w-full items-center gap-2.5 rounded-lg border px-3 text-left transition-all ${open ? "border-primary/60 bg-primary/[0.07] shadow-[var(--shadow-focus)]" : "border-border bg-bg hover:border-primary/40 hover:bg-bg-subtle"}`}
      >
        <span className={`material-symbols-outlined grid size-7 place-items-center rounded-md text-[17px] ${open ? "bg-primary text-white" : "bg-surface-2 text-primary"}`}>person</span>
        <span className="shrink-0 text-sm font-medium text-text-muted">使用人</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-main" title={selectedLabel}>{selectedLabel}</span>
        <span className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${open ? "rotate-180" : ""}`}>expand_more</span>
      </button>

      {open ? (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-full min-w-[280px] overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-elev)]">
          <div className="border-b border-border bg-bg-subtle/60 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">API KEY PERSON</p>
            <p className="mt-0.5 text-xs text-text-muted">选择一个 API Key 查看对应使用数据</p>
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5 custom-scrollbar">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!value}
              onClick={() => selectPerson("")}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${!value ? "bg-primary/10 text-primary" : "text-text-main hover:bg-bg-subtle"}`}
            >
              <span className={`material-symbols-outlined text-[18px] ${!value ? "text-primary" : "text-text-muted"}`}>{!value ? "check_circle" : "groups"}</span>
              <span className="flex-1 font-semibold">全部使用人</span>
              {!value ? <span className="text-[10px] font-bold uppercase tracking-wide">已选择</span> : null}
            </button>
            {apiKeys.map((key) => {
              const active = key.id === value;
              const label = key.name || key.key?.slice(0, 8) || key.id;
              return (
                <button
                  key={key.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => selectPerson(key.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${active ? "bg-primary/10 text-primary" : "text-text-main hover:bg-bg-subtle"}`}
                >
                  <span className={`material-symbols-outlined text-[18px] ${active ? "text-primary" : "text-text-muted"}`}>{active ? "check_circle" : "person"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold" title={label}>{label}</span>
                    <span className="block font-mono text-[10px] text-text-muted">API Key</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

PersonFilterDropdown.propTypes = {
  apiKeys: PropTypes.array.isRequired,
  value: PropTypes.string,
  onChange: PropTypes.func,
};

export default function UsageTimeFilter({ value, onChange, apiKeyId, onApiKeyChange }) {
  const [preset, setPreset] = useState(value?.preset || "today");
  const [anchor, setAnchor] = useState(() => new Date());
  const [customStart, setCustomStart] = useState(value?.startDate ? new Date(value.startDate) : new Date());
  const [customEnd, setCustomEnd] = useState(value?.endDate ? new Date(value.endDate) : new Date());
  const [apiKeys, setApiKeys] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/keys")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) setApiKeys((data?.keys || []).filter((key) => key.isActive !== false));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const range = useMemo(
    () => (preset === "custom" ? { start: atStartOfDay(customStart), end: atEndOfDay(customEnd) } : getRange(preset, anchor)),
    [anchor, customEnd, customStart, preset],
  );
  const today = atEndOfDay(new Date());
  const canGoForward = preset !== "custom" && range.end < today;

  const emit = (nextPreset, nextAnchor = anchor, nextCustomStart = customStart, nextCustomEnd = customEnd) => {
    const nextRange = nextPreset === "custom"
      ? { start: atStartOfDay(nextCustomStart), end: atEndOfDay(nextCustomEnd) }
      : getRange(nextPreset, nextAnchor);
    if (nextRange.start > nextRange.end) return;
    onChange({
      preset: nextPreset,
      startDate: nextRange.start.toISOString(),
      endDate: nextRange.end.toISOString(),
    });
  };

  const selectPreset = (nextPreset) => {
    const nextAnchor = new Date();
    setPreset(nextPreset);
    setAnchor(nextAnchor);
    emit(nextPreset, nextAnchor);
  };

  const moveRange = (direction) => {
    if (preset === "custom" || (direction > 0 && !canGoForward)) return;
    const nextAnchor = shiftAnchor(anchor, preset, direction);
    setAnchor(nextAnchor);
    emit(preset, nextAnchor);
  };

  const updateCustomDate = (field, inputValue) => {
    if (!inputValue) return;
    const nextDate = new Date(`${inputValue}T12:00:00`);
    const nextStart = field === "start" ? nextDate : customStart;
    const nextEnd = field === "end" ? nextDate : customEnd;
    if (nextStart > nextEnd) return;
    setPreset("custom");
    if (field === "start") setCustomStart(nextDate);
    else setCustomEnd(nextDate);
    emit("custom", anchor, nextStart, nextEnd);
  };

  return (
    <section className="relative rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-5">
        <span className="mr-1 text-base font-semibold text-text-main">统计时间</span>
        <button
          type="button"
          onClick={() => moveRange(-1)}
          disabled={preset === "custom"}
          aria-label="上一个统计周期"
          className="grid size-9 place-items-center rounded-full border border-border text-text-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-[20px]">chevron_left</span>
        </button>

        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          {PRESETS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => selectPreset(item.value)}
              className={`min-w-20 border-r border-border px-4 py-2 text-sm font-semibold transition-colors last:border-r-0 ${preset === item.value ? "bg-primary text-white" : "bg-surface text-text-muted hover:bg-bg-subtle hover:text-text-main"}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => moveRange(1)}
          disabled={!canGoForward}
          aria-label="下一个统计周期"
          className="grid size-9 place-items-center rounded-full border border-border text-text-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-[20px]">chevron_right</span>
        </button>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:ml-1 sm:flex-nowrap">
          <label className="relative flex min-w-[190px] flex-1 items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm font-medium text-text-main">
            <span className="material-symbols-outlined text-[18px] text-text-muted">calendar_month</span>
            <span>{toChineseDate(range.start)}</span>
            <input
              type="date"
              value={toInputDate(range.start)}
              max={toInputDate(today)}
              onChange={(event) => updateCustomDate("start", event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="统计开始日期"
            />
          </label>
          <span className="font-semibold text-text-muted">至</span>
          <label className="relative flex min-w-[190px] flex-1 items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm font-medium text-text-main">
            <span>{toChineseDate(range.end)}</span>
            <input
              type="date"
              value={toInputDate(range.end)}
              min={toInputDate(range.start)}
              max={toInputDate(today)}
              onChange={(event) => updateCustomDate("end", event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="统计结束日期"
            />
          </label>
        </div>

        <PersonFilterDropdown apiKeys={apiKeys} value={apiKeyId} onChange={onApiKeyChange} />
      </div>

      <p className="sr-only">当前统计范围：{toChineseDate(range.start)} 至 {toChineseDate(range.end)}</p>
    </section>
  );
}

UsageTimeFilter.propTypes = {
  value: PropTypes.shape({
    preset: PropTypes.string,
    startDate: PropTypes.string,
    endDate: PropTypes.string,
  }),
  onChange: PropTypes.func.isRequired,
  apiKeyId: PropTypes.string,
  onApiKeyChange: PropTypes.func,
};
