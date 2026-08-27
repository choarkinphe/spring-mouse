import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { syncCustomModels } from "@/models";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import { parseModelsDevCatalog } from "@/shared/utils/modelCatalog";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const { providerId, supportedModels } = await request.json();
    const provider = REGISTRY.find((entry) => entry.id === providerId);
    const catalog = provider?.modelCatalog;

    if (!provider || !catalog) {
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
            const id = typeof model === "string" ? model : (model?.id || model?.name);
            if (!id) return null;
            const metadata = catalogById.get(id);
            return metadata || { id, name: model?.name || id, type: "llm", capabilities: {} };
          })
          .filter(Boolean)
      : catalogModels;
    const models = Array.from(new Map(officialModels.map((model) => [model.id, model])).values());

    if (models.length === 0) {
      return NextResponse.json({ error: "The model catalog returned no supported models" }, { status: 502 });
    }

    const providerAlias = provider.uiAlias || provider.alias || provider.id;
    const result = await syncCustomModels(models.map((model) => ({
      ...model,
      providerAlias,
      providerId: provider.id,
      source: catalog.type,
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
