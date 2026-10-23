import { getProviderAlias, resolveProviderId, usesUpstreamModelList } from "@/shared/constants/providers";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

// Old union-sync rows are not evidence that the upstream directory lists a model.
export function isListedCustomModel(model) {
  if (!usesUpstreamModelList(resolveProviderId(model?.providerId || model?.providerAlias))) return true;
  return !["catalog", "models-dev", "static"].includes(model?.source);
}

export function getOfficialModelSnapshot(providerId, snapshots = {}) {
  const canonical = resolveProviderId(providerId);
  const snapshot = snapshots[canonical] || snapshots[providerId];
  return snapshot?.status === "success" && snapshot.source === "official" ? snapshot : null;
}

export function hasOfficialModelSnapshot(providerId, snapshots = {}) {
  return Boolean(getOfficialModelSnapshot(providerId, snapshots));
}

export function shouldUseStaticModelCatalog(providerId, snapshots = {}) {
  return !usesUpstreamModelList(resolveProviderId(providerId)) && !hasOfficialModelSnapshot(providerId, snapshots);
}

export function isVisibleModelCatalogRow(model, snapshots = {}) {
  if (!model?.id) return false;
  const snapshot = getOfficialModelSnapshot(model.providerId || model.providerAlias, snapshots);
  const metadataOnly = model.origin === "capability-override";
  if (!snapshot) return !metadataOnly && isListedCustomModel(model);
  if (!model.source && !metadataOnly) return true;
  const listed = Array.isArray(snapshot.modelIds) && snapshot.modelIds.includes(model.id);
  return listed && (model.source === "official" || metadataOnly);
}

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
  if (source === "official") return "官方同步";
  if (source === "models-dev" || source === "catalog") return "目录";
  if (source === "static") return "内置";
  if (source === "unverified") return "历史同步·未验证";
  return null;
}

export function getModelDisplayCapabilities(model, resolved) {
  const manual = model?.manualCapabilities
    || (model?.origin === "capability-override" || (!model?.modelSource && !model?.source) ? model?.capabilities : null);
  return { ...(resolved || model?.capabilities || {}), ...(manual || {}) };
}

export function getProviderCustomModelRows({
  customModels = [],
  modelAliases = {},
  providerAlias,
  providerAliases = [],
  builtInModels = [],
  type = "llm",
  includeLegacyAliases = true,
  snapshots,
}) {
  const builtInIds = new Set(builtInModels.map((model) => model.id));
  const seenFullModels = new Set();
  const rows = [];

  for (const model of customModels) {
    if (!model?.id || !(snapshots ? isVisibleModelCatalogRow(model, snapshots) : isListedCustomModel(model)) || !(model.providerAlias === providerAlias || providerAliases.includes(model.providerAlias))) continue;
    const snapshot = getOfficialModelSnapshot(model.providerId || model.providerAlias, snapshots);
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
      ...(model.source ? { modelSource: snapshots && !snapshot && model.source === "official" ? "unverified" : model.source } : {}),
      ...(snapshots ? { verified: snapshot?.modelIds?.includes(model.id) === true } : {}),
      ...(model.providerId ? { providerId: model.providerId } : {}),
      ...(model.manualCapabilities ? { manualCapabilities: model.manualCapabilities } : {}),
      ...(model.origin ? { origin: model.origin } : {}),
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
