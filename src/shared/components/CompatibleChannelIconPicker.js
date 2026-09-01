"use client";

import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { CUSTOM_CHANNEL_ICON_OPTIONS } from "@/shared/constants/customChannelIcons";
import { cn } from "@/shared/utils/cn";

export default function CompatibleChannelIconPicker({ value, onChange }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-text-main">Channel icon</legend>
      <p className="mb-3 text-xs leading-5 text-text-muted">Choose a provider logo for this compatible channel. Select Automatic to use the default compatibility icon.</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => onChange("")}
          aria-pressed={!value}
          className={cn(
            "relative flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 py-2 text-center transition-colors",
            !value
              ? "border-[#38bdf8]/70 bg-[#38bdf8]/[0.1] text-[#bae6fd]"
              : "border-border-subtle bg-bg/30 text-text-muted hover:border-[#38bdf8]/35 hover:bg-[#38bdf8]/[0.045] hover:text-text-main",
          )}
        >
          <span className="material-symbols-outlined text-[22px]">auto_awesome</span>
          <span className="max-w-full truncate text-[11px] font-medium">Automatic</span>
          {!value && <span className="material-symbols-outlined absolute right-1.5 top-1.5 text-[15px] text-[#7dd3fc]">check_circle</span>}
        </button>
        {CUSTOM_CHANNEL_ICON_OPTIONS.map((icon) => {
          const selected = value === icon.src;
          return (
            <button
              key={icon.id}
              type="button"
              onClick={() => onChange(icon.src)}
              aria-label={`Use ${icon.label} icon`}
              aria-pressed={selected}
              title={icon.label}
              className={cn(
                "relative flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 py-2 text-center transition-colors",
                selected
                  ? "border-[#38bdf8]/70 bg-[#38bdf8]/[0.1] text-[#bae6fd]"
                  : "border-border-subtle bg-bg/30 text-text-muted hover:border-[#38bdf8]/35 hover:bg-[#38bdf8]/[0.045] hover:text-text-main",
              )}
            >
              <ProviderIcon
                src={icon.src}
                alt=""
                size={24}
                className="size-6 rounded object-contain"
                fallbackText={icon.label.slice(0, 1)}
              />
              <span className="max-w-full truncate text-[11px] font-medium leading-none">{icon.label}</span>
              {selected && <span className="material-symbols-outlined absolute right-1.5 top-1.5 text-[15px] text-[#7dd3fc]">check_circle</span>}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

CompatibleChannelIconPicker.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
};
