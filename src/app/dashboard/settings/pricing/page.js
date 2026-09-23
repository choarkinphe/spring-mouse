"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Toggle from "@/shared/components/Toggle";
import PricingModal from "@/shared/components/PricingModal";

const fmtTime = (iso) => {
  if (!iso) return "从未";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "从未";
  return d.toLocaleString();
};

export default function PricingSettingsPage() {
  const [showModal, setShowModal] = useState(false);
  const [currentPricing, setCurrentPricing] = useState(null);
  const [loading, setLoading] = useState(true);

  const [settings, setSettings] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState(null);

  const loadPricing = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pricing");
      if (response.ok) setCurrentPricing(await response.json());
    } catch (error) {
      console.error("Failed to load pricing:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings");
      if (response.ok) setSettings(await response.json());
    } catch (error) {
      console.error("Failed to load settings:", error);
    }
  }, []);

  // Initial load: fetching server state on mount is the legitimate use of this
  // effect; the rule's concern (cascading renders) does not apply to a one-shot
  // mount fetch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPricing();
    loadSettings();
  }, [loadPricing, loadSettings]);

  const handlePricingUpdated = () => loadPricing();

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const res = await fetch("/api/pricing/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncError(data.error || "同步失败");
        return;
      }
      setSyncResult(data);
      await loadPricing();
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pricingChanged"));
    } catch (error) {
      setSyncError(error.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleAutoSync = async (next) => {
    // Optimistic: the PATCH is authoritative, but the switch should not lag.
    setSettings((prev) => ({ ...(prev || {}), pricingAutoSyncEnabled: next }));
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricingAutoSyncEnabled: next }),
      });
      if (res.ok) setSettings(await res.json());
      else await loadSettings();
    } catch {
      await loadSettings();
    }
  };

  // Count total models with pricing
  const getModelCount = () => {
    if (!currentPricing) return 0;
    let count = 0;
    for (const provider in currentPricing) {
      count += Object.keys(currentPricing[provider]).length;
    }
    return count;
  };

  // Get providers list
  const getProviders = () => {
    if (!currentPricing) return [];
    return Object.keys(currentPricing).sort();
  };

  const autoSyncEnabled = settings?.pricingAutoSyncEnabled === true;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Pricing Settings</h1>
          <p className="text-text-muted mt-1">
            Configure pricing rates for cost tracking and calculations
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors"
        >
          Edit Pricing
        </button>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Total Models
          </div>
          <div className="text-2xl font-bold mt-1">
            {loading ? "..." : getModelCount()}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Providers
          </div>
          <div className="text-2xl font-bold mt-1">
            {loading ? "..." : getProviders().length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Status
          </div>
          <div className="text-2xl font-bold mt-1 text-success">
            {loading ? "..." : "Active"}
          </div>
        </Card>
      </div>

      {/* models.dev sync */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">从 models.dev 同步定价</h2>
            <p className="text-text-muted mt-1 text-sm">
              为尚无定价的模型补齐单价。已有定价（含手工调整）不会被覆盖，
              仅修正被通配符错误匹配的变体。
            </p>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="shrink-0 px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {syncing ? "同步中..." : "立即同步"}
          </button>
        </div>

        {syncError && (
          <p className="mt-3 text-sm text-red-500 break-words">{syncError}</p>
        )}

        {syncResult && (
          <div className="mt-3 text-sm text-text-muted">
            {syncResult.message ? (
              <p>{syncResult.message}</p>
            ) : (
              <p>
                新增 <strong className="text-text-main">{syncResult.added ?? 0}</strong>，
                修正 <strong className="text-text-main">{syncResult.fixed ?? 0}</strong>
                {syncResult.stats ? (
                  <>
                    {" "}· 扫描 {syncResult.stats.scanned}，跳过已有 {syncResult.stats.skippedExisting}
                    {syncResult.stats.unresolved ? `，目录无价 ${syncResult.stats.unresolved}` : ""}
                  </>
                ) : null}
              </p>
            )}
          </div>
        )}

        <div className="mt-4 border-t border-border-subtle pt-4">
          <Toggle
            checked={autoSyncEnabled}
            onChange={handleToggleAutoSync}
            label="定时自动同步"
            description="每 24 小时自动补齐一次缺失定价（可用 SPRING_MOUSE_PRICING_SYNC_INTERVAL_MS 调整间隔）"
            ariaLabel="定时自动同步定价"
          />
          <p className="mt-2 text-xs text-text-muted">
            上次自动同步：{fmtTime(settings?.pricingAutoSyncLastRunAt)}
          </p>
        </div>
      </Card>

      {/* Info Section */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">How Pricing Works</h2>
        <div className="space-y-3 text-sm text-text-muted">
          <p>
            <strong>Cost Calculation:</strong> Costs are calculated based on token usage and pricing rates.
            Each request&apos;s cost is determined by: (input_tokens × input_rate) + (output_tokens × output_rate) + (cached_tokens × cached_rate)
          </p>
          <p>
            <strong>Pricing Format:</strong> All rates are in <strong>dollars per million tokens</strong> ($/1M tokens).
            Example: An input rate of 2.50 means $2.50 per 1,000,000 input tokens.
          </p>
          <p>
            <strong>Token Types:</strong>
          </p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li><strong>Input:</strong> Standard prompt tokens</li>
            <li><strong>Output:</strong> Completion/response tokens</li>
            <li><strong>Cached:</strong> Cached input tokens (typically 50% of input rate)</li>
            <li><strong>Reasoning:</strong> Special reasoning/thinking tokens (fallback to output rate)</li>
            <li><strong>Cache Creation:</strong> Tokens used to create cache entries (fallback to input rate)</li>
          </ul>
          <p>
            <strong>Custom Pricing:</strong> You can override default pricing for specific models.
            Reset to defaults anytime to restore standard rates.
          </p>
        </div>
      </Card>

      {/* Current Pricing Preview */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Current Pricing Overview</h2>
          <button
            onClick={() => setShowModal(true)}
            className="text-primary hover:underline text-sm"
          >
            View Full Details
          </button>
        </div>

        {loading ? (
          <div className="text-center py-4 text-text-muted">Loading pricing data...</div>
        ) : currentPricing ? (
          <div className="space-y-3">
            {Object.keys(currentPricing).slice(0, 5).map(provider => (
              <div key={provider} className="text-sm">
                <span className="font-semibold">{provider.toUpperCase()}:</span>{" "}
                <span className="text-text-muted">
                  {Object.keys(currentPricing[provider]).length} models
                </span>
              </div>
            ))}
            {Object.keys(currentPricing).length > 5 && (
              <div className="text-sm text-text-muted">
                + {Object.keys(currentPricing).length - 5} more providers
              </div>
            )}
          </div>
        ) : (
          <div className="text-text-muted">No pricing data available</div>
        )}
      </Card>

      {/* Pricing Modal */}
      {showModal && (
        <PricingModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onSave={handlePricingUpdated}
        />
      )}
    </div>
  );
}
