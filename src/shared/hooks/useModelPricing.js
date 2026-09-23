"use client";

import { useState, useEffect, useCallback } from "react";

// Module cache: one /api/models fetch shared by every useModelPricing instance.
// Mirrors useModelCaps — both read the same endpoint, and the list is large
// enough (~1300 models) that a per-component fetch would be wasteful.
let cache = null; // { byFull, byId } | null
let inflight = null;

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    // `pricing: null` is meaningful — it means "no price known" and must be
    // distinguishable from "not loaded yet".
    if (m.pricing === undefined) continue;
    if (m.fullModel) byFull[m.fullModel] = m.pricing;
    if (m.routedModel) byFull[m.routedModel] = m.pricing;
    if (m.model) byId[m.model] = m.pricing;
  }
  return { byFull, byId };
}

function loadModelPricing() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      cache = buildMaps(data.models);
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry.
      return { byFull: {}, byId: {} };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function clearModelPricingCache() {
  cache = null;
  inflight = null;
}

// Resolve pricing from a "provider/model" string or a bare model id.
function resolvePricing(byFull, byId, input) {
  const key = typeof input === "string"
    ? input
    : (input && typeof input.model === "string" ? input.model : null);
  if (!key) return null;
  if (key in byFull) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (bare in byId) return byId[bare];
  return null;
}

/**
 * Per-model pricing for the dashboard.
 *
 * Returns `{ getPricing }`, where a result of `null` means no price is known.
 * The caller renders that as "未定价" — an unpriced model records $0 for every
 * request, which is how a large amount of usage went unbilled before this was
 * surfaced.
 */
export function useModelPricing() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});

  useEffect(() => {
    let alive = true;
    Promise.resolve(cache || loadModelPricing()).then((maps) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const handleChange = () => {
      clearModelPricingCache();
      loadModelPricing().then((maps) => {
        setByFull(maps.byFull);
        setById(maps.byId);
      });
    };
    // Both events invalidate pricing: the model list changed, or prices were
    // synced/edited. Without the second one a sync would not refresh the badges.
    window.addEventListener("customModelChanged", handleChange);
    window.addEventListener("pricingChanged", handleChange);
    return () => {
      window.removeEventListener("customModelChanged", handleChange);
      window.removeEventListener("pricingChanged", handleChange);
    };
  }, []);

  const getPricing = useCallback(
    (key) => resolvePricing(byFull, byId, key),
    [byFull, byId],
  );

  return { getPricing };
}

/**
 * Format a per-1M-token rate for display.
 *
 * Unlike `formatCost` (fixed 2 decimals, for totals), rates span several orders
 * of magnitude — $0.0028 for a cache read vs $50 for an output rate. A fixed
 * precision would render most of them as "$0.00".
 */
export function formatRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
