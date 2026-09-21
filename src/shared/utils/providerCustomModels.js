import { getProviderAlias } from "@/shared/constants/providers";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

function modelType(model) {
  return model?.kind || model?.type || "llm";
}

/**
 * Every alias a channel's model rows may be stored under.
 *
 * A preset provider is keyed by its uiAlias (codex → "cx", deepseek → "ds"); a
 * compatible channel is keyed by its raw provider node id, though older rows may
 * carry its display prefix instead. Callers that need to find or delete "all of
 * this channel's rows" must match the full set, not just one form.
 */
export function resolveProviderAliases(providerId, { provider, prefix } = {}) {
  const out = new Set();
  const add = (value) => { if (typeof value === "string" && value.trim()) out.add(value.trim()); };
  add(providerId);
  add(provider);
  add(prefix);
  add(getProviderAlias(providerId));
  add(PROVIDER_ID_TO_ALIAS[providerId]);
  return [...out];
}

// Badge label for a stored custom-model row. Synchronized rows keep the source
// they were imported from so the dashboard can tell "came from the provider's
// own /models" apart from "came from the shared capability catalog".
export function describeModelSource(source) {
  if (source === "official") return "官方";
  if (source === "models-dev" || source === "catalog") return "目录";
  if (source === "static") return "内置";
  return null;
}

export function getProviderCustomModelRows({
  customModels = [],
  modelAliases = {},
  providerAlias,
  providerAliases = [],
  builtInModels = [],
  type = "llm",
  includeLegacyAliases = true,
}) {
  const builtInIds = new Set(builtInModels.map((model) => model.id));
  const seenFullModels = new Set();
  const rows = [];

  for (const model of customModels) {
    if (!model?.id || !(model.providerAlias === providerAlias || providerAliases.includes(model.providerAlias))) continue;
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

  const prefixes = [providerAlias, ...providerAliases]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((value) => `${value}/`);
  for (const [alias, fullModel] of Object.entries(modelAliases || {})) {
    const prefix = prefixes.find((value) => fullModel?.startsWith(value));
    if (typeof fullModel !== "string" || !prefix) continue;
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
