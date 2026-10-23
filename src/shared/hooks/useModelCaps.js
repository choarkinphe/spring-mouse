"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { pickModelCapabilities } from "@/shared/utils/modelCatalog";
import { createComboCapabilityResolver } from "open-sse/services/comboCapabilities.js";

import { createModelCapsCache } from "@/shared/utils/modelCapsCache";

const cache = createModelCapsCache();

function loadModelCaps() {
  return cache.load(async () => {
    const response = await fetch("/api/models", { cache: "no-store" });
    if (!response.ok) throw new Error(`models ${response.status}`);
    return (await response.json()).models;
  }).catch(() => ({ byFull: {}, byId: {} }));
}

// Resolve caps from a "provider/model" string or a bare model id.
function resolveCaps(byFull, byId, input) {
  // Combo entries can be strings or `{ model, schedule }` wrappers. Capability
  // resolution always operates on the concrete model identifier.
  const key = typeof input === "string"
    ? input
    : (input && typeof input.model === "string" ? input.model : null);
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const hasProvider = key.includes("/");
  const bare = hasProvider ? key.slice(key.indexOf("/") + 1) : key;
  if (!hasProvider && byId[bare]) return byId[bare];
  const provider = hasProvider ? key.slice(0, key.indexOf("/")) : null;
  const c = getCapabilitiesForModel(provider, bare);
  return pickModelCapabilities(c);
}

export function useModelCaps(combos) {
  const [byFull, setByFull] = useState(() => cache.peek()?.byFull || {});
  const [byId, setById] = useState(() => cache.peek()?.byId || {});

  const requestGeneration = useRef(0);
  const refresh = useCallback(() => {
    const request = ++requestGeneration.current;
    loadModelCaps().then((maps) => {
      if (request !== requestGeneration.current) return;
      setByFull(maps.byFull);
      setById(maps.byId);
    });
  }, []);

  useEffect(() => {
    refresh();
    return () => { requestGeneration.current += 1; };
  }, [refresh]);

  useEffect(() => {
    const handleChange = () => {
      cache.clear();
      refresh();
    };
    window.addEventListener("customModelChanged", handleChange);
    return () => window.removeEventListener("customModelChanged", handleChange);
  }, [refresh]);

  const getModelCapabilities = useCallback((id) => resolveCaps(byFull, byId, id), [byFull, byId]);
  const resolver = useMemo(() => createComboCapabilityResolver({ combos, getModelCapabilities }), [combos, getModelCapabilities]);
  const getCaps = useCallback(
    (key, options) => (options
      ? createComboCapabilityResolver({ combos, ...options, getModelCapabilities })
      : resolver).getCapabilities(key),
    [resolver, combos, getModelCapabilities],
  );

  return { getCaps };
}
