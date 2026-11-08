"use client";

import { useEffect, useState } from "react";

// Module cache: one /api/provider-nodes fetch shared by every consumer.
// Compatible channels are stored by node id (openai-compatible-chat-<uuid>);
// the dashboard should show the channel's prefix (what combos use) instead.
let cache = null; // { [nodeId]: label } | null
let inflight = null;

function loadLabels() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/provider-nodes")
    .then(async (res) => {
      if (!res.ok) throw new Error(`provider-nodes ${res.status}`);
      const data = await res.json();
      const labels = {};
      for (const node of data.nodes || []) {
        const label = node?.prefix || node?.name;
        if (node?.id && label) labels[node.id] = label;
      }
      cache = labels;
      return cache;
    })
    .catch(() => ({}))
    .finally(() => { inflight = null; });
  return inflight;
}

export function useProviderNodeLabels() {
  const [labels, setLabels] = useState(cache || {});
  useEffect(() => {
    if (cache) return undefined;
    let alive = true;
    loadLabels().then((next) => { if (alive) setLabels(next); });
    return () => { alive = false; };
  }, []);
  return labels;
}

/** Replace a leading node-id segment ("<nodeId>/model") with its display label. */
export function labelModelRoute(value, labels) {
  if (typeof value !== "string" || !labels) return value;
  const slash = value.indexOf("/");
  if (slash <= 0) return labels[value] || value;
  const head = value.slice(0, slash);
  return labels[head] ? `${labels[head]}${value.slice(slash)}` : value;
}
