import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { syncCustomModels } from "@/models";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import {
  fetchModelsDevCatalog,
  mergeSyncedModels,
  MODELS_DEV_CATALOG_URL,
  parseModelsDevCatalog,
  resolveModelsDevProviderKey,
} from "@/shared/utils/modelCatalog";
import { supportsLiveModelSync } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const normalizeSupportedModel = (model) => {
  if (typeof model === "string") {
    return model ? { id: model, name: model, type: "llm", capabilities: {} } : null;
  }

  const id = model?.id || model?.name;
  if (!id) return null;

  return {
    ...model,
    id,
    name: model?.name || id,
    type: model?.type || model?.kind || "llm",
    capabilities: model?.capabilities || {},
  };
};

/**
 * Resolve the external capability catalog for a channel. Registry entries may
 * declare one explicitly; everything else is looked up in the shared mapping
 * table so preset channels do not depend on a per-provider registry edit.
 */
const resolveCatalog = (provider, providerId) => {
  const declared = provider?.modelCatalog;
  if (declared) return declared;
  const providerKey = resolveModelsDevProviderKey(providerId);
  if (!providerKey) return null;
  return { type: "models-dev", url: MODELS_DEV_CATALOG_URL, provider: providerKey };
};

export async function POST(request) {
  try {
    const body = await request.json();
    const providerId = body?.providerId;
    const supportedModels = Array.isArray(body?.supportedModels) ? body.supportedModels : [];
    if (!providerId) {
      return NextResponse.json({ error: "providerId required" }, { status: 400 });
    }

    const provider = REGISTRY.find((entry) => entry.id === providerId);
    const catalog = resolveCatalog(provider, providerId);
    // Compatible channels (openai-compatible-* / anthropic-compatible-*) are
    // provider nodes, not registry entries — they are always syncable.
    const canSyncLive = supportsLiveModelSync(providerId);

    if (!canSyncLive && !catalog) {
      return NextResponse.json({ error: "This provider does not support model synchronization" }, { status: 400 });
    }

    // ── 1. External capability catalog (best effort, never fatal) ───────────
    let catalogModels = [];
    let catalogWarning = "";
    if (catalog?.type === "models-dev" && catalog.provider) {
      const payload = await fetchModelsDevCatalog({ url: catalog.url || MODELS_DEV_CATALOG_URL });
      if (!payload) {
        catalogWarning = "capability catalog unreachable";
      } else {
        catalogModels = parseModelsDevCatalog(payload, catalog.provider);
        if (catalogModels.length === 0) {
          catalogWarning = `capability catalog has no entry for "${catalog.provider}"`;
        }
      }
    }

    const catalogById = new Map(catalogModels.map((model) => [model.id, model]));

    // ── 2. Provider's own /models list (authoritative for naming) ───────────
    const officialModels = supportedModels
      .map((model) => {
        const normalized = normalizeSupportedModel(model);
        if (!normalized) return null;
        const metadata = catalogById.get(normalized.id);
        if (!metadata) return normalized;
        // Catalog metadata wins for capabilities/limits, the provider wins for
        // the id (it is what the endpoint actually accepts).
        return {
          ...normalized,
          ...metadata,
          id: normalized.id,
          name: normalized.name || metadata.name,
          capabilities: { ...(metadata.capabilities || {}), ...(normalized.capabilities || {}) },
        };
      })
      .filter(Boolean);

    // ── 3. Union: official ∪ catalog ───────────────────────────────────────
    // Previously the catalog only *enriched* ids present in the live list, so
    // anything the account's /models endpoint omitted was silently dropped.
    const { models, catalogOnlyCount } = mergeSyncedModels({ officialModels, catalogModels });

    if (models.length === 0) {
      return NextResponse.json(
        { error: catalogWarning || "The model catalog returned no supported models" },
        { status: 502 },
      );
    }

    const providerAlias = provider?.uiAlias || provider?.alias || provider?.id || providerId;
    const result = await syncCustomModels(models.map((model) => ({
      ...model,
      providerAlias,
      providerId: provider?.id || providerId,
      syncedAt: new Date().toISOString(),
    })));
    await refreshModelCapabilityOverrides({ force: true });

    return NextResponse.json({
      success: true,
      total: models.length,
      officialCount: officialModels.length,
      catalogCount: catalogOnlyCount,
      ...(catalogWarning ? { warning: catalogWarning } : {}),
      ...result,
    });
  } catch (error) {
    console.error("Failed to synchronize provider models:", error);
    return NextResponse.json({ error: error.message || "Failed to synchronize provider models" }, { status: 500 });
  }
}
