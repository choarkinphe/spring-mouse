"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { UsageStats, CardSkeleton } from "@/shared/components";
import UsageTimeFilter from "./components/UsageTimeFilter";
import { realtimeRange } from "@/shared/utils/realtimeRange";
import DashboardUsageHeader from "./components/DashboardUsageHeader";

// How often the home page's rolling window advances. Without this the window
// would freeze at whatever instant the page was opened, so "last 24 hours"
// would slowly become "the 24 hours before you opened the tab".
const WINDOW_ADVANCE_MS = 60_000;

// Default range for the usage board: today, local midnight → end of day.
function currentDayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { preset: "today", startDate: start.toISOString(), endDate: end.toISOString() };
}

export default function UsageOverview({ showOverview = true, showBreakdowns = false, initialSystemStatus = null }) {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageOverviewContent
        showOverview={showOverview}
        showBreakdowns={showBreakdowns}
        initialSystemStatus={initialSystemStatus}
      />
    </Suspense>
  );
}

function UsageOverviewContent({ showOverview, showBreakdowns, initialSystemStatus }) {
  // Home page: a rolling realtime window. Usage board: calendar periods.
  const [timeRange, setTimeRange] = useState(() => (showOverview ? realtimeRange("24h") : currentDayRange()));
  const [apiKeyId, setApiKeyId] = useState("");
  const [scopeRevision, setScopeRevision] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Advance the home page's rolling window so it keeps meaning "the last N hours".
  // Keep the range stable while the request-details drawer is open; otherwise the
  // minute tick changes rangeKey, which resets the drawer and sends the user back
  // to the overview before they can inspect a record.
  useEffect(() => {
    if (!showOverview || detailsOpen) return;
    const timer = setInterval(() => {
      setTimeRange((current) => realtimeRange(current?.preset || "24h"));
    }, WINDOW_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [showOverview, detailsOpen]);

  const rangeKey = useMemo(() => `${timeRange.startDate}:${timeRange.endDate}:${apiKeyId}:${scopeRevision}`, [timeRange, apiKeyId, scopeRevision]);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {showOverview ? (
        <DashboardUsageHeader
          initialSystemStatus={initialSystemStatus}
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
        />
      ) : (
        <UsageTimeFilter
          value={timeRange}
          onChange={setTimeRange}
          apiKeyId={apiKeyId}
          onApiKeyChange={setApiKeyId}
          onScopeChanged={() => setScopeRevision((current) => current + 1)}
        />
      )}

      <Suspense fallback={<CardSkeleton />}>
        <UsageStats
          rangeKey={rangeKey}
          timeRange={timeRange}
          apiKeyId={apiKeyId || undefined}
          showOverview={showOverview}
          showBreakdowns={showBreakdowns}
          scope={showOverview ? undefined : "dashboard"}
          onDetailsOpenChange={showOverview ? setDetailsOpen : undefined}
        />
      </Suspense>
    </div>
  );
}
