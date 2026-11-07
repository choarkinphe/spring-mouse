"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { UsageStats, CardSkeleton, Button, Drawer } from "@/shared/components";
import dynamic from "next/dynamic";
import UsageTimeFilter from "./components/UsageTimeFilter";
import { realtimeRange } from "@/shared/utils/realtimeRange";
import { startOfDay, endOfDay } from "@/shared/utils/datetime";
import DashboardUsageHeader from "./components/DashboardUsageHeader";
const AccountCostsPanel = dynamic(() => import("./components/AccountCostsPanel"), {
  loading: () => <CardSkeleton />,
});

// How often the home page's rolling window advances. Without this the window
// would freeze at whatever instant the page was opened, so "last 24 hours"
// would slowly become "the 24 hours before you opened the tab".
const WINDOW_ADVANCE_MS = 60_000;

// Default range for the usage board: today, in APP_TIMEZONE (the server buckets
// by its own local day, so the browser's midnight would disagree).
function currentDayRange() {
  const now = new Date();
  return { preset: "today", startDate: startOfDay(now).toISOString(), endDate: endOfDay(now).toISOString() };
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
  const [costsOpen, setCostsOpen] = useState(false);

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
          actions={showBreakdowns ? (
            <Button type="button" variant="secondary" icon="account_balance_wallet" onClick={() => setCostsOpen(true)} aria-haspopup="dialog" aria-expanded={costsOpen}>
              成本看板
            </Button>
          ) : null}
        />
      )}

      {showBreakdowns && (
        <Drawer isOpen={costsOpen} onClose={() => setCostsOpen(false)} title="成本看板" width="3xl" bodyClassName="p-3 sm:p-6">
          <div role="dialog" aria-modal="true" aria-label="成本看板">
            {costsOpen && <AccountCostsPanel timeRange={timeRange} apiKeyId={apiKeyId} />}
          </div>
        </Drawer>
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
