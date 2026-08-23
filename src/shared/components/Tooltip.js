"use client";

export default function Tooltip({ text, children, position = "top", color }) {
  const posClass = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[position];

  const bgStyle = color ? { backgroundColor: color } : undefined;

  return (
    <div className="relative inline-flex group/tt">
      {children}
      <div
        className={`pointer-events-none absolute ${posClass} z-50 w-max max-w-64 rounded-lg border border-border-subtle bg-surface px-2.5 py-2 text-[11px] leading-5 text-text-main shadow-xl opacity-0 group-hover/tt:opacity-100 transition-opacity duration-150 whitespace-pre-line`}
        style={bgStyle}
      >
        {text}
      </div>
    </div>
  );
}
