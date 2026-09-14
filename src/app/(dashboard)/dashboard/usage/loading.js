import { UsageDashboardSkeleton } from "@/shared/components/UsageStats";

/** Keep the route fallback identical to the in-page usage data fallback. */
export default function UsagePageLoading() {
  return <UsageDashboardSkeleton showOverview showBreakdowns={false} />;
}
