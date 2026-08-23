"use client";

import { create } from "zustand";
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";

const useProviderStore = create((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  lastFetched: 0,
  request: null,

  setProviders: (providers) => set({ providers, lastFetched: Date.now() }),

  addProvider: (provider) =>
    set((state) => ({ providers: [provider, ...state.providers] })),

  updateProvider: (id, updates) =>
    set((state) => ({
      providers: state.providers.map((p) =>
        p._id === id ? { ...p, ...updates } : p
      ),
    })),

  removeProvider: (id) =>
    set((state) => ({
      providers: state.providers.filter((p) => p._id !== id),
    })),

  invalidate: () => set({ lastFetched: 0 }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  // Skips network when cache is fresh; concurrent callers share one request.
  fetchProviders: async ({ force = false } = {}) => {
    const { lastFetched, providers, request } = get();
    if (!force && providers.length > 0 && Date.now() - lastFetched < CLIENT_STORE_TTL_MS) return providers;
    if (request) return request;

    set({ loading: true, error: null });
    const pending = (async () => {
      try {
        const response = await fetch("/api/providers");
        const data = await response.json();
        if (response.ok) {
          const nextProviders = data.connections || data.providers || [];
          set({ providers: nextProviders, lastFetched: Date.now(), error: null });
          return nextProviders;
        }
        set({ error: data.error || "Failed to fetch providers" });
        return null;
      } catch {
        set({ error: "Failed to fetch providers" });
        return null;
      } finally {
        set({ loading: false, request: null });
      }
    })();
    set({ request: pending });
    return pending;
  },
}));

export default useProviderStore;

