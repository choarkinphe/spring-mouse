"use client";

import PropTypes from "prop-types";
import { REALTIME_PRESETS, realtimeRange } from "@/shared/utils/realtimeRange";

/**
 * Time selector for the dashboard home page.
 *
 * The home page answers "what is happening right now", so it offers rolling
 * windows rather than calendar periods. This is deliberately separate from
 * `UsageTimeFilter` (which drives the usage board): that one navigates calendar
 * weeks/months and manages the dashboard tag scope, none of which applies here.
 *
 * The range math lives in `@/shared/utils/realtimeRange` so it is unit-testable
 * (this repo's test runner does not transform JSX in `.js` files).
 */
export default function RealtimeTimeFilter({ value, onChange, disabled = false }) {
  const active = value?.preset || "24h";

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm sm:px-5">
      <span className="text-base font-semibold text-text-main">实时统计</span>
      <div role="radiogroup" aria-label="实时统计窗口" className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface-2 p-0.5">
        {REALTIME_PRESETS.map((preset) => {
          const selected = active === preset.value;
          return (
            <button
              key={preset.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(realtimeRange(preset.value))}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? "bg-brand-500 text-white shadow-sm"
                  : "text-text-muted hover:bg-surface hover:text-text-main"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <span className="text-xs text-text-muted">滚动窗口，随当前时间推进</span>
    </section>
  );
}

RealtimeTimeFilter.propTypes = {
  value: PropTypes.shape({
    preset: PropTypes.string,
    startDate: PropTypes.string,
    endDate: PropTypes.string,
  }),
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};
