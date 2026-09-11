function modelType(model) {
  return model?.kind || model?.type || "llm";
}

// Badge label for a stored custom-model row. Synchronized rows keep the source
// they were imported from so the dashboard can tell "came from the provider's
// own /models" apart from "came from the shared capability catalog".
export function describeModelSource(source) {
  if (source === "official") return "官方";
  if (source === "models-dev" || source === "catalog") return "目录";
  return null;
}

export function getProviderCustomModelRows({
  customModels = [],
  modelAliases = {},
  providerAlias,
  builtInModels = [],
  type = "llm",
  includeLegacyAliases = true,
}) {
  const builtInIds = new Set(builtInModels.map((model) => model.id));
  const seenFullModels = new Set();
  const rows = [];

  for (const model of customModels) {
    if (!model?.id || model.providerAlias !== providerAlias) continue;
    const rowType = modelType(model);
    if (type && rowType !== type) continue;
    if (builtInIds.has(model.id)) continue;

    const fullModel = `${providerAlias}/${model.id}`;
    if (seenFullModels.has(fullModel)) continue;
    seenFullModels.add(fullModel);
    rows.push({
      id: model.id,
      name: model.name || model.id,
      fullModel,
      source: "custom",
      type: rowType,
      // Only surfaced when the synchronized row actually carries them, so rows
      // created by hand keep their original shape.
      ...(model.source ? { modelSource: model.source } : {}),
      ...(model.providerId ? { providerId: model.providerId } : {}),
      ...(model.capabilities && Object.keys(model.capabilities).length > 0
        ? { capabilities: model.capabilities }
        : {}),
    });
  }

  if (!includeLegacyAliases) return rows;

  const prefix = `${providerAlias}/`;
  for (const [alias, fullModel] of Object.entries(modelAliases || {})) {
    if (typeof fullModel !== "string" || !fullModel.startsWith(prefix)) continue;
    const id = fullModel.slice(prefix.length);
    if (!id || builtInIds.has(id) || seenFullModels.has(fullModel)) continue;

    seenFullModels.add(fullModel);
    rows.push({
      id,
      alias,
      fullModel,
      source: "legacyAlias",
      type: type || "llm",
    });
  }

  return rows;
}
