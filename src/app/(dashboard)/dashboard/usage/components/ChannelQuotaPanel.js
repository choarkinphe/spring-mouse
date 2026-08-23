"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import { AI_PROVIDERS, USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { formatQuotaBalance, getQuotaCache, getRemainingPercentage, parseQuotaData, setQuotaCache } from "./ProviderLimits/utils";
import useProviderStore from "@/store/providerStore";
import useSettingsStore from "@/store/settingsStore";

const QUOTA_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const QUOTA_FETCH_CONCURRENCY = 3;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }));

  return results;
}

function canTrackQuota(connection) {
  const isApiKey = connection.authType === "apikey" || connection.authType === "api_key";
  return connection.isActive !== false
    && USAGE_SUPPORTED_PROVIDERS.includes(connection.provider)
    && (connection.authType === "oauth" || (isApiKey && USAGE_APIKEY_PROVIDERS.includes(connection.provider)));
}

function getChannelLabel(connection) {
  return connection.displayName?.trim()
    || connection.name?.trim()
    || connection.email?.trim()
    || AI_PROVIDERS[connection.provider]?.name
    || connection.provider;
}

function isFreshCache(entry) {
  const cachedAt = entry?.cachedAt ? new Date(entry.cachedAt).getTime() : 0;
  return cachedAt > 0 && Date.now() - cachedAt < QUOTA_CACHE_MAX_AGE_MS;
}

function toQuotaSnapshot(connection, quotas) {
  if (!Array.isArray(quotas) || quotas.length === 0) return null;

  const balanceQuota = quotas.find((quota) => Number(quota?.balance) > 0 && formatQuotaBalance(quota))
    || quotas.find((quota) => formatQuotaBalance(quota));
  if (balanceQuota) {
    return {
      id: connection.id,
      label: getChannelLabel(connection),
      icon: getProviderIconSrc(connection.provider),
      quotaName: balanceQuota.name || "余额",
      kind: "balance",
      balance: Number(balanceQuota.balance),
      value: formatQuotaBalance(balanceQuota),
      progress: balanceQuota.balance > 0 ? 100 : 0,
    };
  }

  const measured = quotas
    .filter((quota) => quota?.total !== 0 && quota?.total !== null)
    .map((quota) => ({ quota, remaining: getRemainingPercentage(quota) }))
    .filter(({ remaining }) => Number.isFinite(remaining))
    .sort((a, b) => a.remaining - b.remaining)[0];
  if (measured) {
    return {
      id: connection.id,
      label: getChannelLabel(connection),
      icon: getProviderIconSrc(connection.provider),
      quotaName: measured.quota.name || "额度",
      kind: "percentage",
      value: `${measured.remaining}%`,
      progress: measured.remaining,
    };
  }

  if (quotas.some((quota) => quota?.total === 0 || quota?.total === null)) {
    return {
      id: connection.id,
      label: getChannelLabel(connection),
      icon: getProviderIconSrc(connection.provider),
      quotaName: "额度",
      kind: "unlimited",
      value: "不限额",
      progress: 100,
    };
  }

  return null;
}

function defaultCompare(a, b) {
  if (a.kind !== b.kind) return a.kind === "balance" ? -1 : b.kind === "balance" ? 1 : 0;
  if (a.kind === "percentage") return a.progress - b.progress;
  return a.label.localeCompare(b.label, "zh-CN");
}

function applyCustomOrder(snapshots, order) {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...snapshots].sort((a, b) => {
    const aPosition = positions.get(a.id);
    const bPosition = positions.get(b.id);
    if (aPosition !== undefined || bPosition !== undefined) {
      if (aPosition === undefined) return 1;
      if (bPosition === undefined) return -1;
      return aPosition - bPosition;
    }
    return defaultCompare(a, b);
  });
}

function quotaTone(snapshot) {
  if (snapshot.kind === "unlimited") return "border-sky-400/20 bg-sky-400/[0.07] text-sky-300";
  if (snapshot.progress <= 5) return "border-rose-400/25 bg-rose-400/[0.08] text-rose-300";
  if (snapshot.progress <= 30) return "border-amber-400/25 bg-amber-400/[0.08] text-amber-200";
  return "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300";
}

export default function ChannelQuotaPanel() {
  const [snapshots, setSnapshots] = useState([]);
  const [quotaOrder, setQuotaOrder] = useState([]);
  const [quotaHidden, setQuotaHidden] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortOpen, setSortOpen] = useState(false);

  const loadQuotaSummary = useCallback(async ({ force = false } = {}) => {
    setLoading(true);
    try {
      const [connections, settings] = await Promise.all([
        useProviderStore.getState().fetchProviders({ force }),
        useSettingsStore.getState().fetchSettings({ force }),
      ]);
      if (!connections) throw new Error("Failed to fetch channels");

      if (settings) {
        setQuotaOrder(Array.isArray(settings.dashboardQuotaOrder) ? settings.dashboardQuotaOrder : []);
        setQuotaHidden(Array.isArray(settings.dashboardQuotaHidden) ? settings.dashboardQuotaHidden : []);
      }

      const cached = getQuotaCache();
      const cachedResults = [];
      const pendingConnections = [];
      for (const connection of connections.filter(canTrackQuota)) {
        const entry = cached[connection.id];
        if (!force && isFreshCache(entry)) cachedResults.push({ connection, quotas: entry.quotas || [] });
        else pendingConnections.push(connection);
      }

      const fetchedResults = await mapWithConcurrency(pendingConnections, QUOTA_FETCH_CONCURRENCY, async (connection) => {
        try {
          const response = await fetch(`/api/usage/${connection.id}${force ? "?force=1" : ""}`, { cache: "no-store" });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data?.error) return null;
          const quotas = parseQuotaData(connection.provider, data);
          setQuotaCache(connection.id, { quotas, message: data.message || null });
          return { connection, quotas };
        } catch {
          return null;
        }
      });

      setSnapshots(
        [...cachedResults, ...fetchedResults.filter(Boolean)]
          .map(({ connection, quotas }) => toQuotaSnapshot(connection, quotas))
          .filter(Boolean),
      );
    } catch {
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Quota APIs can be remote and slow. Let the primary dashboard render and
    // become interactive before issuing these background requests.
    const run = () => void loadQuotaSummary();
    const idleId = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(run, { timeout: 1500 })
      : null;
    const timer = idleId === null ? window.setTimeout(run, 700) : null;

    return () => {
      if (idleId !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleId);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadQuotaSummary]);

  const orderedSnapshots = useMemo(() => applyCustomOrder(snapshots, quotaOrder), [snapshots, quotaOrder]);
  const visibleSnapshots = useMemo(
    () => orderedSnapshots.filter((snapshot) => !quotaHidden.includes(snapshot.id)),
    [orderedSnapshots, quotaHidden],
  );

  const savePreferences = async ({ order = quotaOrder, hidden = quotaHidden } = {}) => {
    setQuotaOrder(order);
    setQuotaHidden(hidden);
    try {
      await useSettingsStore.getState().patchSettings({
        dashboardQuotaOrder: order,
        dashboardQuotaHidden: hidden,
      });
    } catch {
      // The local preferences remain visible; the next adjustment retries persistence.
    }
  };

  const moveSnapshot = (index, offset) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= orderedSnapshots.length) return;
    const next = [...orderedSnapshots];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    void savePreferences({ order: next.map((snapshot) => snapshot.id) });
  };

  const toggleSnapshotVisibility = (id) => {
    const nextHidden = quotaHidden.includes(id)
      ? quotaHidden.filter((hiddenId) => hiddenId !== id)
      : [...quotaHidden, id];
    void savePreferences({ hidden: nextHidden });
  };

  return (
    <Card className="relative flex max-h-[280px] min-w-0 flex-none flex-col overflow-visible xl:max-h-[calc(100%-17rem)]" padding="sm">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-1 py-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-text-muted">account_balance_wallet</span>
          <span className="text-sm font-semibold text-text-main">渠道余量</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void loadQuotaSummary({ force: true })}
            disabled={loading}
            className="grid size-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-bg-subtle hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            title="刷新渠道余量"
            aria-label="刷新渠道余量"
          >
            <span className={`material-symbols-outlined text-[18px] ${loading ? "animate-spin" : ""}`}>refresh</span>
          </button>
          <button
            type="button"
            onClick={() => setSortOpen((value) => !value)}
            className={`grid size-7 place-items-center rounded-md transition-colors ${sortOpen ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-bg-subtle hover:text-primary"}`}
            title="自定义排序"
            aria-label="自定义渠道余量排序"
          >
            <span className="material-symbols-outlined text-[18px]">sort</span>
          </button>
        </div>
      </div>

      {sortOpen && (
        <div className="absolute right-3 top-11 z-40 w-[min(22rem,calc(100vw-3rem))] rounded-xl border border-border bg-surface p-2 shadow-[var(--shadow-elev)]">
          <div className="flex items-center justify-between gap-3 px-2 py-1.5">
            <div>
              <p className="text-sm font-semibold text-text-main">自定义排序</p>
              <p className="text-[11px] text-text-muted">排序和显示状态会保存到当前服务配置。</p>
            </div>
            <button type="button" onClick={() => void savePreferences({ order: [], hidden: [] })} className="text-xs text-primary hover:text-primary/80">恢复默认</button>
          </div>
          <div className="mt-1 max-h-64 space-y-1 overflow-y-auto">
            {orderedSnapshots.map((snapshot, index) => (
              <div key={snapshot.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-subtle">
                {snapshot.icon ? (
                  // Provider icons are tiny decorative badges; they are loaded lazily.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={snapshot.icon} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-xs text-text-main">{snapshot.label}</span>
                <span className="text-xs text-text-muted">{snapshot.value}</span>
                <button type="button" onClick={() => toggleSnapshotVisibility(snapshot.id)} className="grid size-6 place-items-center rounded text-text-muted hover:bg-surface-2 hover:text-primary" aria-label={`${quotaHidden.includes(snapshot.id) ? "显示" : "隐藏"} ${snapshot.label}`} title={quotaHidden.includes(snapshot.id) ? "显示" : "隐藏"}>
                  <span className="material-symbols-outlined text-[16px]">{quotaHidden.includes(snapshot.id) ? "visibility_off" : "visibility"}</span>
                </button>
                <button type="button" onClick={() => moveSnapshot(index, -1)} disabled={index === 0} className="grid size-6 place-items-center rounded text-text-muted hover:bg-surface-2 hover:text-primary disabled:opacity-30" aria-label={`上移 ${snapshot.label}`}>
                  <span className="material-symbols-outlined text-[16px]">keyboard_arrow_up</span>
                </button>
                <button type="button" onClick={() => moveSnapshot(index, 1)} disabled={index === orderedSnapshots.length - 1} className="grid size-6 place-items-center rounded text-text-muted hover:bg-surface-2 hover:text-primary disabled:opacity-30" aria-label={`下移 ${snapshot.label}`}>
                  <span className="material-symbols-outlined text-[16px]">keyboard_arrow_down</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1.5 custom-scrollbar">
        {loading && orderedSnapshots.length === 0 ? (
          <div className="space-y-1 px-1">
            <div className="h-10 animate-pulse rounded-md bg-bg-subtle" />
            <div className="h-10 animate-pulse rounded-md bg-bg-subtle" />
            <div className="h-10 animate-pulse rounded-md bg-bg-subtle" />
          </div>
        ) : visibleSnapshots.length > 0 ? (
          <div className="space-y-1 px-1">
            {visibleSnapshots.map((snapshot) => (
              <div key={snapshot.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_minmax(4.5rem,1fr)_5rem_auto] items-center gap-2 rounded-md border border-border bg-bg-subtle/40 px-2 py-1.5">
                {snapshot.icon ? (
                  // Provider icons are tiny decorative badges; they are loaded lazily.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={snapshot.icon} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
                ) : null}
                <span className="min-w-0 truncate text-xs font-medium text-text-main" title={snapshot.label}>{snapshot.label}</span>
                <span className="min-w-0 truncate text-right text-[11px] text-text-muted" title={snapshot.quotaName}>{snapshot.quotaName}</span>
                <div className="h-1 w-20 justify-self-end overflow-hidden rounded-full bg-border">
                  <div className={`h-full rounded-full ${snapshot.progress <= 5 ? "bg-rose-400" : snapshot.progress <= 30 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${Math.max(0, Math.min(snapshot.progress, 100))}%` }} />
                </div>
                <span className={`justify-self-end rounded border px-1.5 py-0.5 font-mono text-[11px] ${quotaTone(snapshot)}`}>{snapshot.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-20 items-center justify-center px-5 text-center text-sm text-text-muted">
            {orderedSnapshots.length > 0 ? "所有渠道余量均已隐藏，可在排序设置中恢复显示。" : "暂无可读取的渠道余量。"}
          </div>
        )}
      </div>
    </Card>
  );
}
