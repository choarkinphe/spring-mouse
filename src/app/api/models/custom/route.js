import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel, upsertModelCapabilities, getProviderConnectionById } from "@/models";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import { normalizeModelCapabilities, fetchModelsDevCatalog, lookupModelInCatalog } from "@/shared/utils/modelCatalog";
import { compressedJsonResponse } from "@/lib/http/compressedJsonResponse";
import { getModelSyncSnapshots } from "@/lib/db/repos/modelSyncRepo.js";
import { getCodexImageCandidates } from "@/shared/utils/codexImageModels";

export const dynamic = "force-dynamic";

// GET /api/models/custom - List all custom models
export async function GET(request) {
  try {
    const [models, snapshots] = await Promise.all([getCustomModels(), getModelSyncSnapshots()]);
    // ≈770KB uncompressed; see compressedJsonResponse for why route handlers
    // have to opt in. Snapshots are provider-level authoritative markers and
    // must not be inferred from individual model rows.
    return compressedJsonResponse(request, { models, snapshots });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name, connectionId } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    if (["cx", "codex"].includes(providerAlias) && type === "image") {
      const connection = connectionId ? await getProviderConnectionById(connectionId) : null;
      if (!connection || connection.id !== connectionId || connection.provider !== "codex" || connection.isActive === false) {
        return NextResponse.json({ error: "请选择一个启用的 Codex 账号" }, { status: 400 });
      }
      if (!getCodexImageCandidates(null, connectionId).some((candidate) => candidate.id === id)) {
        return NextResponse.json({ error: "请选择 Codex 原生图像模型 gpt-image-2；聊天模型及旧版图像别名不可用于新增配置" }, { status: 400 });
      }
    }
    // Bare model ids added by hand carry no modality data — borrow the shared
    // catalog's spec sheet (cross-provider id lookup) so vision/reasoning etc.
    // resolve correctly instead of falling back to name patterns.
    let capabilities = null;
    try {
      const payload = await fetchModelsDevCatalog();
      const catalogEntry = lookupModelInCatalog(payload, id, null);
      if (catalogEntry?.capabilities && Object.keys(catalogEntry.capabilities).length > 0) {
        capabilities = catalogEntry.capabilities;
      }
    } catch { /* catalog unreachable — add without capabilities */ }
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", name, capabilities });
    await refreshModelCapabilityOverrides({ force: true });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// PATCH /api/models/custom - Update per-model capability metadata.
// Works for user-added / synchronized models AND for built-in registry models
// (a capability-only override row is created on demand).
export async function PATCH(request) {
  try {
    const { providerAlias, providerId, id, type, capabilities } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const normalized = normalizeModelCapabilities(capabilities || {});
    const result = await upsertModelCapabilities({
      providerAlias,
      providerId: providerId || undefined,
      id,
      type: type || "llm",
      capabilities: normalized,
    });
    await refreshModelCapabilityOverrides({ force: true });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.log("Error updating model capabilities:", error);
    return NextResponse.json({ error: "Failed to update model capabilities" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    await refreshModelCapabilityOverrides({ force: true });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
