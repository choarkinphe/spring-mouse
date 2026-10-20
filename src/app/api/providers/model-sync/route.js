import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getProviderConnectionById, syncCustomModels } from "@/models";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import {
  fetchModelsDevCatalog,
  parseModelsDevCatalog,
  MODELS_DEV_CATALOG_URL,
  resolveModelsDevProviderKey,
} from "@/shared/utils/modelCatalog";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { OFFICIAL_MODEL_CATALOG } from "@/shared/config/officialModelCatalog";
import { discoverConnectionModels } from "@/lib/services/officialModelDiscovery";

export const dynamic = "force-dynamic";

const normalizeModel = (model) => {
  if (typeof model === "string") return model.trim() ? { id: model.trim(), name: model.trim(), type: "llm" } : null;
  if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id.trim()) return null;
  return { ...model, id: model.id, name: model.name || model.id };
};

const resolveCatalog = (provider, providerId) => {
  if (provider?.modelCatalog) return provider.modelCatalog;
  const key = resolveModelsDevProviderKey(providerId);
  return key ? { type: "models-dev", url: MODELS_DEV_CATALOG_URL, provider: key } : null;
};

/**
 * Persist only a successful, non-empty official directory. The endpoint is
 * deliberately re-run here rather than trusting a browser's model array or
 * `officialFetched` flag. A public directory is still marked public: it is
 * discovery evidence, not an account entitlement check.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const providerId = typeof body?.providerId === "string" ? body.providerId : "";
    const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
    if (!providerId) return NextResponse.json({ error: "providerId is required" }, { status: 400 });
    const provider = REGISTRY.find((entry) => entry.id === providerId);
    const publicWithoutConnection = !connectionId && provider?.noAuth === true && OFFICIAL_MODEL_CATALOG[providerId]?.scope === "public";
    if (!connectionId && !publicWithoutConnection) return NextResponse.json({ error: "providerId and connectionId are required" }, { status: 400 });
    const connection = publicWithoutConnection ? { id: `public:${providerId}`, provider: providerId, isActive: true } : await getProviderConnectionById(connectionId);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    if (connection.isActive === false) return NextResponse.json({ error: "Connection is inactive" }, { status: 409 });
    if (connection.provider !== providerId) {
      return NextResponse.json({ error: "Connection does not belong to provider" }, { status: 400 });
    }
    const discovered = await discoverConnectionModels(connection);
    if (discovered.error) {
      return NextResponse.json({ error: discovered.error, discovery: { status: discovered.unsupported ? "unsupported" : "failed", source: "official" } }, { status: discovered.status || 502 });
    }
    const officialModels = discovered.models.map(normalizeModel).filter(Boolean);
    // Empty success is observable but not destructive. This prevents an
    // upstream outage or account with no entitlement from deleting a useful
    // prior directory; retrying a successful non-empty listing is required.
    if (officialModels.length === 0) {
      return NextResponse.json({
        error: "Official directory returned no models; existing synchronized models were not changed",
        discovery: discovered.discovery,
      }, { status: 409 });
    }

    // models.dev (when available) is metadata only. It can enrich an ID that
    // the official directory returned, never add a catalog-only ID.
    const catalog = resolveCatalog(provider, providerId);
    let catalogModels = [];
    let warning;
    if (catalog?.type === "models-dev" && catalog.provider) {
      const payload = await fetchModelsDevCatalog({ url: catalog.url || MODELS_DEV_CATALOG_URL });
      if (payload) catalogModels = parseModelsDevCatalog(payload, catalog.provider);
      else warning = "capability catalog unavailable; official model IDs were retained";
    }
    const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
    const staticById = new Map(getModelsByProviderId(providerId).map((model) => [model.id, model]));
    const models = officialModels.map((official) => {
      // Runtime routing annotations are not discovery sources. Keep only
      // known-ID annotations; never spread the static registry's extra IDs.
      const known = staticById.get(official.id);
      const routing = {};
      for (const key of ["supportedFormats", "targetFormat", "upstreamModelId", "quotaFamily", "kind", "type"]) {
        if (known?.[key] !== undefined) routing[key] = known[key];
      }
      const allowedKinds = new Set(["llm", "imageToText", "embedding", "image", "tts", "stt", "webSearch", "webFetch", "systemone", "video", "music"]);
      const declaredKind = allowedKinds.has(official.kind) ? official.kind : allowedKinds.has(official.type) ? official.type : null;
      const providerKind = provider?.serviceKinds?.length === 1 ? provider.serviceKinds[0] : null;
      const type = declaredKind || known?.kind || known?.type || (allowedKinds.has(providerKind) ? providerKind : "llm");
      const model = { ...routing, ...official, type, kind: type };
      const metadata = catalogById.get(model.id);
      if (!metadata) return { ...model, source: "official" };
      const providerName = model.name && model.name !== model.id ? model.name : "";
      return {
        ...metadata,
        ...model,
        id: model.id,
        name: providerName || metadata.name || model.id,
        capabilities: { ...(metadata.capabilities || {}), ...(model.capabilities || {}) },
        source: "official",
      };
    });

    const providerAlias = provider?.uiAlias || provider?.alias || providerId;
    const result = await syncCustomModels(models.map((model) => ({
      ...model,
      providerAlias,
      providerId,
      syncedAt: new Date().toISOString(),
    })), {
      replaceSyncedFor: providerAlias,
      syncSnapshot: {
        providerId,
        providerAlias,
        connectionId: connection.id,
        scope: discovered.listingScope || discovered.discovery?.scope || "account",
        models,
      },
    });
    await refreshModelCapabilityOverrides({ force: true });

    return NextResponse.json({
      success: true,
      total: models.length,
      officialCount: officialModels.length,
      catalogCount: models.filter((model) => catalogById.has(model.id)).length,
      staticCount: 0,
      ...(warning ? { warning } : {}),
      discovery: discovered.discovery,
      ...result,
    });
  } catch (error) {
    console.error("Failed to synchronize provider models:", error);
    return NextResponse.json({ error: error.message || "Failed to synchronize provider models" }, { status: 500 });
  }
}
