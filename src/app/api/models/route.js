import { NextResponse } from "next/server";
import { getCustomModels, getModelAliases, setModelAlias, getProviderNodes } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { isVisibleModelCatalogRow, shouldUseStaticModelCatalog, hasOfficialModelSnapshot } from "@/shared/utils/providerCustomModels";
import { getModelSyncSnapshots } from "@/lib/db/repos/modelSyncRepo.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { pickModelCapabilities } from "@/shared/utils/modelCatalog";
import { getPricingForModels } from "@/lib/db/repos/pricingRepo.js";
import { toCompactPricing } from "@/shared/utils/pricingSync";
import { modelCreditBilling } from "open-sse/config/creditBilling.js";
import { compressedJsonResponse } from "@/lib/http/compressedJsonResponse";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";

// GET /api/models - Get models with aliases
export async function GET(request) {
  try {
    await refreshModelCapabilityOverrides();
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();
    const snapshots = await getModelSyncSnapshots();
    const [customModels, providerNodes] = await Promise.all([
      getCustomModels(),
      getProviderNodes().catch(() => []),
    ]);
    const visibleCustomModels = (customModels || []).filter((model) => isVisibleModelCatalogRow(model, snapshots));
    // Compatible channels are addressed by their display prefix in combos
    // ("scnet/model"), but rows are keyed by the node id — routedModel must use
    // the prefix or client-side capability lookup misses the row.
    const nodePrefixById = new Map();
    for (const node of providerNodes || []) {
      if (node?.id && node?.prefix) nodePrefixById.set(node.id, node.prefix);
    }

    const models = AI_MODELS
      .filter((m) => {
        if (!shouldUseStaticModelCatalog(m.provider, snapshots)) return false;
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          modelSource: "static",
          verified: false,
          // Full capability set — the dashboard renders one badge per modality,
          // so trimming to vision/search/reasoning here would hide the rest.
          caps: pickModelCapabilities(c),
        };
      });

    const seen = new Set(models.flatMap((model) => [model.fullModel, model.routedModel]));
    for (const custom of visibleCustomModels || []) {
      if (!custom?.providerAlias || !custom?.id || (custom.type && custom.type !== "llm")) continue;
      const routedPrefix = nodePrefixById.get(custom.providerAlias) || nodePrefixById.get(custom.providerId) || custom.providerAlias;
      const routedModel = `${routedPrefix}/${custom.id}`;
      if (seen.has(routedModel)) continue;
      const providerId = custom.providerId || custom.providerAlias;
      const disabledIds = disabled[custom.providerAlias] || disabled[providerId] || [];
      if (disabledIds.includes(custom.id)) continue;
      const c = getCapabilitiesForModel(providerId, custom.id);
      models.push({
        provider: providerId,
        model: custom.id,
        name: custom.name || custom.id,
        rateMultiplier: custom.rateMultiplier,
        originalRateMultiplier: custom.originalRateMultiplier,
        fullModel: routedModel,
        routedModel,
        alias: modelAliases[routedModel] || custom.id,
        modelSource: custom.source === "official" && !hasOfficialModelSnapshot(providerId, snapshots) ? "unverified" : custom.source || "manual",
        verified: custom.source === "official" && hasOfficialModelSnapshot(providerId, snapshots),
        caps: pickModelCapabilities(c),
      });
      seen.add(routedModel);
    }

    // Attach pricing in one pass. `provider` is the registry id (what usage rows
    // and the pricing tables key on) — deliberately NOT `routedModel`, whose
    // prefix is the UI alias.
    const pricingByKey = await getPricingForModels(
      models.map((m) => ({ provider: m.provider, model: m.model })),
    );
    for (const m of models) {
      m.creditBilling = modelCreditBilling(m.provider, m);
      m.pricing = m.creditBilling ? null : toCompactPricing(pricingByKey.get(`${m.provider}/${m.model}`));
    }

    // Compressed: this is the largest dashboard read (≈890KB uncompressed, ≈50KB
    // gzipped) and route handlers do not get Next's compression middleware.
    return compressedJsonResponse(request, { models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
