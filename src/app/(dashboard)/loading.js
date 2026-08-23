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
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
        <ModuleSkeleton title="正在装载页面模块" icon="view_quilt" lines={6} className="min-h-[360px]" />
        <div className="flex flex-col gap-4">
          <ModuleSkeleton title="正在同步服务状态" icon="sync" lines={4} className="min-h-[170px]" />
          <ModuleSkeleton title="正在准备辅助数据" icon="dataset" lines={4} className="min-h-[170px]" />
        </div>
      </div>
    </div>
  );
}
