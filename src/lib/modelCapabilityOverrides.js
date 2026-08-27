import { getCustomModels } from "@/lib/localDb";
import { replaceModelCapabilityOverrides } from "open-sse/providers/capabilities.js";

const REFRESH_INTERVAL_MS = 30_000;
let loadedAt = 0;
let inflight = null;

export async function refreshModelCapabilityOverrides({ force = false } = {}) {
  if (!force && loadedAt > 0 && Date.now() - loadedAt < REFRESH_INTERVAL_MS) return;
  if (inflight) return inflight;

  inflight = getCustomModels()
    .then((models) => {
      const entries = [];
      for (const model of models || []) {
        if (!model?.id || !model?.capabilities) continue;
        const providers = new Set([model.providerAlias, model.providerId].filter(Boolean));
        for (const provider of providers) {
          entries.push({ provider, model: model.id, capabilities: model.capabilities });
        }
      }
      replaceModelCapabilityOverrides(entries);
      loadedAt = Date.now();
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
