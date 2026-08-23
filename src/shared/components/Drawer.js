"use client";

import { useEffect } from "react";
import { cn } from "@/shared/utils/cn";

export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  width = "md",
  className,
  bodyRef,
  zIndex = "z-50",
  lockScroll = true,
}) {
  const widths = {
    sm: "w-[400px]",
    md: "w-[500px]",
    lg: "w-[600px]",
    xl: "w-[800px]",
    "2xl": "w-full max-w-[1200px]",
    "3xl": "w-full max-w-[1500px]",
    full: "w-full",
  };

  useEffect(() => {
    if (!lockScroll || !isOpen) return undefined;

    const body = document.body;
    const currentLocks = Number(body.dataset.drawerScrollLocks || 0);
    body.dataset.drawerScrollLocks = String(currentLocks + 1);
    body.style.overflow = "hidden";

    return () => {
      const remainingLocks = Math.max(0, Number(body.dataset.drawerScrollLocks || 1) - 1);
      if (remainingLocks === 0) {
        delete body.dataset.drawerScrollLocks;
        body.style.overflow = "";
      } else {
        body.dataset.drawerScrollLocks = String(remainingLocks);
      }
    };
  }, [isOpen, lockScroll]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={cn("fixed inset-0", zIndex)}>
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div className={cn(
        "absolute right-0 top-0 h-full bg-surface flex flex-col",
        "shadow-[var(--shadow-elev)]",
        "slide-in-right",
        "border-l border-border-subtle",
        widths[width] || widths.md,
        className
      )}>
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-3">
            {title && (
              <h2 className="text-lg font-semibold text-text-main">{title}</h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-[10px] text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {children}
        </div>
      </div>
    </div>
  );
}
