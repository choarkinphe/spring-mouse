import UsageOverview from "./usage/UsageOverview";
import { getSystemStatus } from "@/lib/system/status";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  // Keep the two cheapest facts (uptime/version) on first paint. The client keeps
  // refreshing the fuller status snapshot after hydration.
  return <UsageOverview initialSystemStatus={getSystemStatus()} />;
}
