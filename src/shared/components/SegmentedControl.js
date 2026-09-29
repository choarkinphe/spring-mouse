"use client";

import { cn } from "@/shared/utils/cn";

export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
}) {
  const sizes = {
    xs: "h-7 text-[11px]",
    sm: "h-7 text-xs",
    md: "h-9 text-sm",
    lg: "h-11 text-base",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center p-1 rounded-[10px] overflow-x-auto",
        "bg-surface-2",
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            // inline-flex + items-center so an icon and the label share a centre
            // line. With the default baseline alignment the icon (an inline-block
            // with line-height:1) rides ~7px above the label instead.
            "inline-flex items-center justify-center gap-1.5 shrink-0 rounded-[8px] font-medium transition-all",
            size === "xs" ? "px-2" : "px-4",
            sizes[size],
            value === option.value
              ? "bg-surface text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main"
          )}
        >
          {option.icon && (
            // `!` is required: globals.css sets `.material-symbols-outlined
            // { font-size: 24px }` at the same specificity, and without the
            // important suffix the icon renders 24px instead of 16px.
            <span className="material-symbols-outlined text-[16px]! shrink-0">
              {option.icon}
            </span>
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}
