"use client";

import PropTypes from "prop-types";
import { REALTIME_PRESETS, realtimeRange } from "@/shared/utils/realtimeRange";

/**
 * Rolling-window selector for the dashboard home page, rendered inline on the
 * header's eyebrow line.
 *
 * Deliberately styled as plain text rather than a segmented control: it sits in
 * a line of copy, so a bordered pill group would read as a separate widget and
 * fight the typography. The active window carries the emphasis instead.
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
    <div role="radiogroup" aria-label="实时统计窗口" className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {REALTIME_PRESETS.map((preset, index) => {
        const selected = active === preset.value;
        return (
          <span key={preset.value} className="inline-flex items-center gap-1.5">
            {index > 0 ? <span aria-hidden="true" className="text-primary/35">·</span> : null}
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(realtimeRange(preset.value))}
              className={`rounded-sm text-xs transition-colors ${
                selected
                  ? "font-semibold text-primary"
                  : "font-medium text-text-muted hover:text-primary"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              {preset.label}
            </button>
          </span>
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
