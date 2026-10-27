"use client";

import { useMemo, useState } from "react";
import { formatDate, formatTime, formatShortDateTime } from "@/shared/utils/datetime";
import { formatQuotaAmount, formatQuotaRemainingLabel, formatResetTime, getRemainingPercentage } from "./utils";
import { reconcilePagination } from "./pagination";

const PAGE_SIZE = 10;
const EMPTY_QUOTAS = [];

/**
 * Format reset time display (Today, 12:00 PM)
 */
function formatResetTimeDisplay(resetTime) {
  if (!resetTime) return null;

  try {
    const date = new Date(resetTime);
    const now = new Date();
    // Day comparison in APP_TIMEZONE, matching the server's day buckets.
    const dayKey = (d) => formatDate(d);
    let dayStr = "";
    if (dayKey(date) === dayKey(now)) {
      dayStr = "Today";
    } else if (dayKey(date) === dayKey(new Date(now.getTime() + 86400000))) {
      dayStr = "Tomorrow";
    } else {
      dayStr = formatShortDateTime(date);
    }

    const timeStr = formatTime(date);

    return `${dayStr}, ${timeStr}`;
  } catch {
    return null;
  }
}

/**
 * Get color classes based on remaining percentage
 */
function getColorClasses(remainingPercentage) {
  if (remainingPercentage > 70) {
    return {
      text: "text-green-600 dark:text-green-400",
      bg: "bg-green-500",
      bgLight: "bg-green-500/10",
      emoji: "🟢",
    };
  }

  if (remainingPercentage >= 30) {
    return {
      text: "text-yellow-600 dark:text-yellow-400",
      bg: "bg-yellow-500",
      bgLight: "bg-yellow-500/10",
      emoji: "🟡",
    };
  }

  return {
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500",
    bgLight: "bg-red-500/10",
    emoji: "🔴",
  };
}

function sortQuotas(quotas, sortMode) {
  if (sortMode === "remaining-asc") {
    return [...quotas].sort((a, b) => a.remaining - b.remaining || a.name.localeCompare(b.name));
  }

  if (sortMode === "remaining-desc") {
    return [...quotas].sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  }

  return quotas;
}

/**
 * Quota Table Component - Table-based display for quota data
 */
export default function QuotaTable({
  quotas = EMPTY_QUOTAS,
  compact = false,
  sortMode = "default",
  showSortLabel = false,
  onHideQuota = null,
}) {
  const [pagination, setPagination] = useState(() => ({ quotas, sortMode, page: 1 }));

  const normalizedQuotas = useMemo(
    () => quotas.map((quota, index) => ({
      ...quota,
      index,
      remaining: getRemainingPercentage(quota),
    })),
    [quotas],
  );

  const sortedQuotas = useMemo(
    () => sortQuotas(normalizedQuotas, sortMode),
    [normalizedQuotas, sortMode],
  );

  const totalPages = Math.max(1, Math.ceil(sortedQuotas.length / PAGE_SIZE));

  const currentPagination = reconcilePagination(pagination, quotas, sortMode, totalPages);
  // Reconcile before committing so a reset/clamp cannot revive an old page later.
  if (currentPagination !== pagination) {
    setPagination(currentPagination);
  }
  const { page } = currentPagination;

  function changePage(offset) {
    setPagination((current) => {
      const next = reconcilePagination(current, quotas, sortMode, totalPages);
      return { ...next, page: Math.max(1, Math.min(totalPages, next.page + offset)) };
    });
  }

  if (!quotas || quotas.length === 0) {
    return null;
  }

  const currentPageRows = sortedQuotas.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );
  const pageStart = sortedQuotas.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, sortedQuotas.length);

  const cellPad = compact ? "py-1 px-1.5" : "py-2 px-3";
  const nameText = compact ? "text-[11px]" : "text-sm";
  const resetPrimary = compact ? "text-[11px]" : "text-sm";
  const resetSecondary = compact ? "text-[10px] leading-tight" : "text-xs";
  const sortLabel = "Sorted by account remaining";
  const hasHideAction = typeof onHideQuota === "function";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-text-muted">
          {sortedQuotas.length} quota{sortedQuotas.length > 1 ? "s" : ""}
        </div>
        {showSortLabel && (
          <div className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1 text-[10px] text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
            {sortLabel}
          </div>
        )}
      </div>

      <div className="space-y-px">
        {currentPageRows.map((quota) => {
          const colors = getColorClasses(quota.remaining);
          const countdown = formatResetTime(quota.resetAt);
          const resetDisplay = formatResetTimeDisplay(quota.resetAt);
          const amountLabel = formatQuotaAmount(quota) ?? "—";
          const remainingLabel = formatQuotaRemainingLabel(quota);
          // recurring defaults true: a missing flag means the quota
          // refreshes at resetAt. Bonus/one-shot packs set recurring:false
          // and their resetAt is a hard expiry, so word it as "expires".
          const recurring = quota.recurring !== false;
          const countdownLabel = /^\d{4}-\d{2}-\d{2}$/.test(countdown)
            ? countdown
            : recurring ? `in ${countdown}` : `expires in ${countdown}`;

          return (
            <div
              key={`${quota.name}-${quota.index}`}
              className={`flex items-center gap-2 border-b border-black/5 dark:border-white/5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors ${cellPad}`}
            >
              {/* Name */}
              <div className="flex w-36 min-w-0 items-center gap-1.5">
                <span className="text-[10px] shrink-0">{colors.emoji}</span>
                <span className={`${nameText} font-medium text-text-primary truncate`} title={quota.displayName || quota.name}>
                  {quota.displayName || quota.name}
                </span>
              </div>

              {/* Remaining progress + usage detail */}
              <div className={`min-w-0 flex-1 ${compact ? "space-y-1" : "space-y-1.5"}`}>
                <div role="progressbar" aria-label={`${quota.displayName || quota.name} 剩余比例`} aria-valuenow={Math.max(0, Math.min(quota.remaining, 100))} aria-valuemin={0} aria-valuemax={100} title={`剩余 ${quota.remaining}%`} className={`${compact ? "h-1" : "h-1.5"} rounded-full overflow-hidden border ${colors.bgLight} ${
                  quota.remaining === 0 ? "border-black/10 dark:border-white/10" : "border-transparent"
                }`}>
                  <div
                    className={`h-full transition-all duration-300 ${colors.bg}`}
                    style={{ width: `${Math.min(quota.remaining, 100)}%` }}
                  />
                </div>

                <div className={`flex items-center justify-between gap-1 min-w-0 ${compact ? "text-[10px]" : "text-xs"}`}>
                  <span className={`font-medium ${colors.text} truncate`} title={quota.balance !== undefined ? `账户余额：${amountLabel}` : `已用 / 总量：${amountLabel}`}>
                    {remainingLabel}
                  </span>
                </div>
              </div>

              {/* Reset time */}
              <div className="min-w-0 shrink">
                {countdown !== "-" || resetDisplay ? (
                  compact ? (
                    <div
                      className={`${resetPrimary} text-text-primary font-medium truncate`}
                      title={resetDisplay || ""}
                    >
                      {countdown !== "-" ? countdownLabel : resetDisplay}
                    </div>
                  ) : (
                    <div className="min-w-0 space-y-0.5">
                      {countdown !== "-" && (
                        <div className={`${resetPrimary} text-text-primary font-medium truncate`}>
                          {countdownLabel}
                        </div>
                      )}
                      {resetDisplay && (
                        <div className={`${resetSecondary} text-text-muted truncate`}>
                          {resetDisplay}
                        </div>
                      )}
                    </div>
                  )
                ) : (
                  <div className={`${resetPrimary} text-text-muted italic`}>N/A</div>
                )}
              </div>

              {/* Hide action */}
              {hasHideAction && (
                <button
                  type="button"
                  onClick={() => onHideQuota(quota)}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
                  title="Hide this quota row"
                  aria-label={`Hide quota ${quota.displayName || quota.name}`}
                >
                  <span className="material-symbols-outlined text-[15px]">
                    visibility_off
                  </span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1.5 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted">
            <span>
              Showing {pageStart}-{pageEnd} of {sortedQuotas.length}
            </span>
            <span>
              Page {page} / {totalPages}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => changePage(-1)}
              disabled={page === 1}
              className="flex h-6 items-center rounded-md border border-black/10 px-2 text-[10px] text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => changePage(1)}
              disabled={page === totalPages}
              className="flex h-6 items-center rounded-md border border-black/10 px-2 text-[10px] text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
