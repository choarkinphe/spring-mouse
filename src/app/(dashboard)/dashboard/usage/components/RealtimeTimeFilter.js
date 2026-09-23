"use client";

import PropTypes from "prop-types";
import { REALTIME_PRESETS, realtimeRange } from "@/shared/utils/realtimeRange";

/**
 * Rolling-window selector for the dashboard home page, rendered inside the
 * header so the window and its numbers read as one unit.
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
    <div
      role="radiogroup"
      aria-label="实时统计窗口"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border-subtle bg-surface-2 p-0.5"
    >
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
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
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
