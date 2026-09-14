import { ModuleSkeleton, Skeleton } from "@/shared/components";

/**
 * Route-level fallback used while a dashboard segment or its JavaScript bundle
 * is loading. Individual pages replace these blocks with their own data as it
 * becomes available.
 */
export default function DashboardLoading() {
  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0" aria-live="polite">
      <section className="rounded-2xl border border-border bg-surface/70 px-5 py-4 shadow-[var(--shadow-soft)]" aria-busy="true">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl border border-primary/20 bg-primary/[0.08] text-primary">
            <span className="material-symbols-outlined animate-spin text-[22px]">progress_activity</span>
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-[min(20rem,75%)]" />
            <Skeleton className="h-2.5 w-[min(28rem,90%)]" />
          </div>
        </div>
      </section>
      <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 xl:h-[min(58rem,calc(100vh-8rem))] xl:grid-cols-[minmax(0,1fr)_minmax(360px,400px)]">
        <div className="flex min-w-0 flex-col gap-2 xl:h-full xl:min-h-0">
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 sm:gap-4 2xl:grid-cols-[1.4fr_1fr_1fr_1fr]">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="rounded-xl border border-border bg-surface/70 px-4 py-3 shadow-[var(--shadow-soft)]">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-3 h-7 w-20" />
                {index < 3 && <div className={`mt-3 grid ${index === 2 ? "grid-cols-2" : "grid-cols-3"} gap-1.5`}>
                  {Array.from({ length: index === 2 ? 2 : 3 }, (_, metricIndex) => <Skeleton key={metricIndex} className="h-8 w-full rounded-md" />)}
                </div>}
              </div>
            ))}
          </div>
          <ModuleSkeleton title="正在汇总实时调用" icon="account_tree" lines={5} className="min-h-[320px] xl:min-h-0 xl:flex-1" />
        </div>
        <div className="flex min-w-0 flex-col gap-2 xl:h-full xl:min-h-0">
          <ModuleSkeleton title="正在读取渠道余量" icon="account_balance_wallet" lines={4} className="min-h-[230px] xl:min-h-0 xl:flex-1" />
          <ModuleSkeleton title="正在读取最近请求" icon="receipt_long" lines={5} className="min-h-[240px]" />
        </div>
      </div>
      <ModuleSkeleton title="正在生成使用趋势" icon="monitoring" lines={6} className="min-h-[440px]" />
    </div>
  );
}
