"use client";

import { create } from "zustand";
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";

const useSettingsStore = create((set, get) => ({
  settings: null,
  loading: false,
  error: null,
  lastFetched: 0,
  request: null,

  invalidate: () => set({ lastFetched: 0 }),

  // Skips network when cache is fresh; concurrent callers share one request.
  fetchSettings: async ({ force = false } = {}) => {
    const { lastFetched, settings, request } = get();
    if (!force && settings && Date.now() - lastFetched < CLIENT_STORE_TTL_MS) return settings;
    if (request) return request;

    set({ loading: true, error: null });
    const pending = (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        if (res.ok) {
          set({ settings: data, lastFetched: Date.now(), error: null });
          return data;
        }
        set({ error: data.error || "Failed to fetch settings" });
        return null;
      } catch {
        set({ error: "Failed to fetch settings" });
        return null;
      } finally {
        set({ loading: false, request: null });
      }
    })();
    set({ request: pending });
    return pending;
  },

  // PATCH server + merge into local cache (no extra fetch needed)
  patchSettings: async (patch) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return null;
      const updated = await res.json();
      set({ settings: updated, lastFetched: Date.now() });
      return updated;
    } catch {
      return null;
    }
  },
}));

export default useSettingsStore;
