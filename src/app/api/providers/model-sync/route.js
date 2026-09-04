import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { syncCustomModels } from "@/models";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import { parseModelsDevCatalog } from "@/shared/utils/modelCatalog";
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

export async function POST(request) {
  try {
    const { providerId, supportedModels } = await request.json();
    const isCompatibleChannel = supportsLiveModelSync(providerId);
    const provider = REGISTRY.find((entry) => entry.id === providerId);
    const catalog = provider?.modelCatalog;

    if (!isCompatibleChannel && (!provider || !catalog)) {
      return NextResponse.json({ error: "This provider does not support model synchronization" }, { status: 400 });
    }

    const response = await fetch(catalog.url, { cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json({ error: `Failed to fetch model catalog: ${response.status}` }, { status: 502 });
    }

    const payload = await response.json();
    const catalogModels = catalog.type === "models-dev"
      ? parseModelsDevCatalog(payload, catalog.provider)
      : [];

    const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
    const officialModels = Array.isArray(supportedModels)
      ? supportedModels
          .map((model) => {
            const normalized = normalizeSupportedModel(model);
            if (!normalized) return null;
            const metadata = catalogById.get(normalized.id);
            return metadata ? {
              ...normalized,
              ...metadata,
              id: normalized.id,
            } : normalized;
          })
          .filter(Boolean)
      : catalogModels;
    const models = Array.from(new Map(officialModels.map((model) => [model.id, model])).values());

    if (models.length === 0) {
      return NextResponse.json({ error: "The model catalog returned no supported models" }, { status: 502 });
    }

    const providerAlias = provider?.uiAlias || provider?.alias || provider.id;
    const result = await syncCustomModels(models.map((model) => ({
      ...model,
      providerAlias,
      providerId: provider?.id || providerId,
      source: catalog?.type || "official",
      syncedAt: new Date().toISOString(),
    })));
    await refreshModelCapabilityOverrides({ force: true });

    return NextResponse.json({
      success: true,
      total: models.length,
      ...result,
    });
  } catch (error) {
    console.error("Failed to synchronize provider models:", error);
    return NextResponse.json({ error: error.message || "Failed to synchronize provider models" }, { status: 500 });
  }
}
