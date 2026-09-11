"use client";

import { cn } from "@/shared/utils/cn";

/**
 * A compact, capability-center style page header used across dashboard workspaces.
 * It keeps the visual cue from Media Services while leaving more room for data-heavy
 * management pages below.
 */
export default function DashboardHero({
  eyebrow,
  title,
  description,
  icon,
  children,
  action,
  className,
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-[16px] border border-brand-500/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.10),rgba(99,102,241,0.07)_45%,transparent_75%)] px-4 py-3.5 sm:px-5 sm:py-4",
        className
      )}
    >
      <div aria-hidden="true" className="absolute -right-5 -top-8 text-brand-500/[0.055]">
        <span className="material-symbols-outlined text-[132px]">{icon}</span>
      </div>
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-600 dark:text-brand-300">{eyebrow}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-text-main sm:text-2xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-5 text-text-muted">{description}</p>
        </div>
        {/* Stats and the page action share one right-hand row so the hero does not
            grow a second line just to hold the badges. */}
        {(children || action) && (
          <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 sm:justify-end sm:pb-0.5">
            {children}
            {action}
          </div>
        )}
      </div>
    </section>
  );
}
