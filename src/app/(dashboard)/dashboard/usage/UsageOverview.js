"use client";

import { Suspense, useMemo, useState } from "react";
import { UsageStats, CardSkeleton } from "@/shared/components";
import UsageTimeFilter from "./components/UsageTimeFilter";
import DashboardUsageHeader from "./components/DashboardUsageHeader";

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
  const [timeRange, setTimeRange] = useState(currentDayRange);
  const [apiKeyId, setApiKeyId] = useState("");
  const rangeKey = useMemo(() => `${timeRange.startDate}:${timeRange.endDate}:${apiKeyId}`, [timeRange, apiKeyId]);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {showOverview ? (
        <DashboardUsageHeader initialSystemStatus={initialSystemStatus} />
      ) : (
        <UsageTimeFilter value={timeRange} onChange={setTimeRange} apiKeyId={apiKeyId} onApiKeyChange={setApiKeyId} />
      )}

      <Suspense fallback={<CardSkeleton />}>
        <UsageStats
          key={rangeKey}
          timeRange={timeRange}
          apiKeyId={apiKeyId || undefined}
          showOverview={showOverview}
          showBreakdowns={showBreakdowns}
        />
      </Suspense>
    </div>
  );
}
