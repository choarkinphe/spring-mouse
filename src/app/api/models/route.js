import { NextResponse } from "next/server";
import { getCustomModels, getModelAliases, setModelAlias } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();
    const customModels = await getCustomModels();

    const customByRoute = new Map();
    for (const model of customModels || []) {
      if (!model?.providerAlias || !model?.id || (model.type && model.type !== "llm")) continue;
      customByRoute.set(`${model.providerAlias}/${model.id}`, model);
      if (model.providerId) customByRoute.set(`${model.providerId}/${model.id}`, model);
    }

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const synced = customByRoute.get(routedModel) || customByRoute.get(fullModel);
        const c = { ...getCapabilitiesForModel(m.provider, m.model), ...(synced?.capabilities || {}) };
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    const seen = new Set(models.flatMap((model) => [model.fullModel, model.routedModel]));
    for (const custom of customModels || []) {
      if (!custom?.providerAlias || !custom?.id || (custom.type && custom.type !== "llm")) continue;
      const routedModel = `${custom.providerAlias}/${custom.id}`;
      if (seen.has(routedModel)) continue;
      const providerId = custom.providerId || custom.providerAlias;
      const c = { ...getCapabilitiesForModel(providerId, custom.id), ...(custom.capabilities || {}) };
      models.push({
        provider: providerId,
        model: custom.id,
        name: custom.name || custom.id,
        fullModel: routedModel,
        routedModel,
        alias: modelAliases[routedModel] || custom.id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
        },
      });
      seen.add(routedModel);
    }

    return NextResponse.json({ models });
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
