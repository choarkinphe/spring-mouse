import { ModuleSkeleton, Skeleton } from "@/shared/components";

/**
 * Dedicated route fallback for /dashboard/usage. This takes precedence while
 * the usage page segment is being resolved, so navigation never falls back to
 * a single centered spinner.
 */
export default function UsagePageLoading() {
  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0" aria-live="polite">
      <section className="rounded-xl border border-border bg-surface/75 p-3 shadow-[var(--shadow-soft)]" aria-busy="true">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-4 w-14" />
          <div className="flex gap-1 rounded-lg border border-border bg-bg-subtle p-1">
            <Skeleton className="h-7 w-14" />
            <Skeleton className="h-7 w-14" />
            <Skeleton className="h-7 w-14" />
          </div>
          <Skeleton className="h-9 min-w-[13rem] flex-1" />
          <Skeleton className="h-9 min-w-[13rem] flex-1" />
          <Skeleton className="h-9 w-40" />
        </div>
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.75fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ModuleSkeleton title="正在聚合调用统计" icon="analytics" lines={5} className="min-h-[280px]" />
          <ModuleSkeleton title="正在生成使用趋势" icon="monitoring" lines={6} className="min-h-[360px]" />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ModuleSkeleton title="正在读取渠道余量" icon="account_balance_wallet" lines={4} className="min-h-[190px]" />
          <ModuleSkeleton title="正在整理调用明细" icon="receipt_long" lines={5} className="min-h-[240px]" />
        </div>
      </div>
    </div>
  );
}
