"use client";

import PropTypes from "prop-types";

// Selection checkbox used by the list cards (batch model operations). Shared
// because ModelRow and CompatibleModelCard must offer the exact same affordance.
// The icon size is inline: the global .material-symbols-outlined rule (24px, not
// wrapped in a layer) wins over Tailwind text-[Npx] utilities.
export default function SelectionCheckbox({ checked = false, onChange, label }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={checked ? "取消选择" : "选择"}
      onClick={(event) => {
        event.stopPropagation();
        onChange?.();
      }}
      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
        checked
          ? "border-brand-500 bg-brand-500 text-white"
          : "border-border bg-surface-2 text-transparent hover:border-primary/60"
      }`}
    >
      <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>check</span>
    </button>
  );
}

SelectionCheckbox.propTypes = {
  checked: PropTypes.bool,
  onChange: PropTypes.func,
  label: PropTypes.string,
};
