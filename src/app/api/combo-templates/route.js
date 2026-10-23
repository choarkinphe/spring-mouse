import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getProviderConnections } from "@/lib/localDb";
import { getCustomModels, getModelAliases } from "@/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getModelSyncSnapshots } from "@/lib/db/repos/modelSyncRepo.js";
import { getPricingForModels } from "@/lib/db/repos/pricingRepo.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { isVisibleModelCatalogRow, shouldUseStaticModelCatalog, hasOfficialModelSnapshot } from "@/shared/utils/providerCustomModels";
import { AI_MODELS } from "@/shared/constants/config";
import {
  TEMPLATE_KINDS,
  buildTemplateMembers,
  getTemplateLabel,
  templateComboName,
} from "@/shared/utils/comboTemplates.js";
import { getCombos } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/**
 * Models a template may draw from: the ones an ACTIVE connection can actually
 * serve right now.
 *
 * /api/models lists the static catalog, which is far wider than what this
 * install is connected to (96 providers vs 5 here). Building a template from
 * that list would produce a combo whose members cannot answer.
 */
async function collectRoutableModels() {
  const connections = (await getProviderConnections()).filter((connection) => connection.isActive !== false);
  // `probe` is a synthetic provider used by the dashboard's connectivity tests;
  // it never serves a real request.
  const providers = new Set(connections.map((connection) => connection.provider).filter((id) => id && id !== "probe"));
  if (providers.size === 0) return [];

  const disabled = await getDisabledModels();
  const snapshots = await getModelSyncSnapshots();
  const aliases = await getModelAliases();

  const candidates = AI_MODELS.filter((entry) => {
    if (!providers.has(entry.provider)) return false;
    if (!shouldUseStaticModelCatalog(entry.provider, snapshots)) return false;
    const alias = getProviderAlias(entry.provider) || entry.provider;
    const list = disabled[alias] || disabled[entry.provider] || [];
    return !list.includes(entry.model);
  });

  // Custom models are keyed by provider ALIAS, while `providers` holds provider
  // ids; map both directions so a custom model on a connected provider counts.
  const aliasToProvider = new Map();
  for (const id of providers) aliasToProvider.set(getProviderAlias(id) || id, id);

  const custom = (await getCustomModels())
    .filter((model) => isVisibleModelCatalogRow(model, snapshots))
    .filter((model) => aliasToProvider.has(model.providerAlias))
    .map((model) => ({
      provider: aliasToProvider.get(model.providerAlias),
      model: model.id,
      name: model.name || model.id,
      fullModel: `${model.providerAlias}/${model.id}`,
      routedModel: `${model.providerAlias}/${model.id}`,
      alias: aliases[`${model.providerAlias}/${model.id}`] || model.id,
    }));

  const merged = [...candidates, ...custom].map((entry) => {
    const fullModel = entry.fullModel || `${entry.provider}/${entry.model}`;
    return {
      provider: entry.provider,
      model: entry.model,
      name: entry.name || entry.model,
      fullModel,
      routedModel: entry.routedModel || fullModel,
      alias: entry.alias || entry.model,
      caps: getCapabilitiesForModel(entry.provider, entry.model),
    };
  });

  const pricing = await getPricingForModels(merged.map((entry) => ({ provider: entry.provider, model: entry.model })));
  for (const entry of merged) {
    const found = pricing.get(`${entry.provider}/${entry.model}`);
    if (found) entry.pricing = { input: found.input, output: found.output };
  }
  return merged;
}

/**
 * GET /api/combo-templates
 *
 * What each template would build right now, and why it cannot be built when it
 * cannot. The dashboard renders the reason verbatim rather than guessing.
 */
export async function GET() {
  try {
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (session?.authenticated !== true) return json({ error: "Authentication required" }, 401);

    const models = await collectRoutableModels();
    const combos = await getCombos();
    const existingNames = combos.map((combo) => combo.name);

    const templates = TEMPLATE_KINDS.map((kind) => {
      const label = getTemplateLabel(kind);
      const built = buildTemplateMembers(kind, models);
      return {
        kind,
        name: label?.name || kind,
        summary: label?.summary || "",
        members: built.members,
        ready: built.members.length > 0,
        need: built.need || null,
        of: built.of || null,
        // The name a click would create, so the UI can show it before creating.
        comboName: built.members.length > 0 ? templateComboName(kind, existingNames) : null,
      };
    });

    return json({ templates, routableModels: models.length });
  } catch (error) {
    console.log("Error building combo templates:", error);
    return json({ error: "Failed to build combo templates" }, 500);
  }
}
