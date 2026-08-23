"use client";

import { cn } from "@/shared/utils/cn";

// Spinner loading
export function Spinner({ size = "md", className }) {
  const sizes = {
    sm: "size-4",
    md: "size-6",
    lg: "size-8",
    xl: "size-12",
  };

  return (
    <span
      className={cn(
        "material-symbols-outlined animate-spin text-brand-500",
        sizes[size],
        className
      )}
    >
      progress_activity
    </span>
  );
}

// Full page loading
export function PageLoading({ message = "Loading..." }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg">
      <Spinner size="xl" />
      <p className="mt-4 text-text-muted">{message}</p>
    </div>
  );
}

// Skeleton loading
export function Skeleton({ className, ...props }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[10px] bg-surface-2",
        className
      )}
      {...props}
    />
  );
}


/**
 * A panel-shaped placeholder for data-driven dashboard modules. It preserves
 * the page composition while the module loads, rather than replacing the
 * entire page with a blocking spinner.
 */
export function ModuleSkeleton({
  title = "正在加载数据",
  icon = "data_object",
  lines = 3,
  className,
  children,
}) {
  return (
    <section
      aria-busy="true"
      aria-label={title}
      className={cn(
        "relative min-w-0 overflow-hidden rounded-xl border border-border bg-surface/70 p-4 shadow-[var(--shadow-soft)]",
        className,
      )}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
      <div className="mb-4 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg border border-primary/20 bg-primary/[0.08] text-primary">
          <span className="material-symbols-outlined text-[17px]">{icon}</span>
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-text-main">
            {title}
            <span className="material-symbols-outlined animate-spin text-[13px] text-primary">progress_activity</span>
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-text-muted">FETCHING MODULE DATA…</p>
        </div>
      </div>
      {children || (
        <div className="space-y-3" aria-hidden="true">
          {Array.from({ length: lines }, (_, index) => (
            <div key={index} className="flex items-center gap-3">
              <span className="size-2 shrink-0 rounded-full bg-primary/30" />
              <Skeleton className={cn("h-2.5", index === lines - 1 ? "w-2/5" : index % 2 ? "w-4/5" : "w-full")} />
            </div>
          ))}
        </div>
      )}
      <span className="sr-only">{title}</span>
    </section>
  );
}

// Card skeleton
export function CardSkeleton() {
  return (
    <div className="p-6 rounded-[14px] border border-border-subtle bg-surface shadow-[var(--shadow-soft)]">
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="size-10 rounded-[10px]" />
      </div>
      <Skeleton className="h-8 w-16 mb-2" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

export default function Loading({ type = "spinner", ...props }) {
  switch (type) {
    case "page":
      return <PageLoading {...props} />;
    case "skeleton":
      return <Skeleton {...props} />;
    case "card":
      return <CardSkeleton {...props} />;
    default:
      return <Spinner {...props} />;
  }
}
