import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel, upsertModelCapabilities } from "@/models";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import { normalizeModelCapabilities } from "@/shared/utils/modelCatalog";

export const dynamic = "force-dynamic";

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", name });
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
