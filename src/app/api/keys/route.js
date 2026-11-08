import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getSettings } from "@/lib/localDb";
import { getApiKeyQuotaStatuses } from "@/lib/apiKeyQuota";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const [keys, settings] = await Promise.all([getApiKeys(), getSettings()]);
    const quotaStatuses = await getApiKeyQuotaStatuses(keys);
    const accessTagsByKey = settings.apiKeyAccessTags || {};
    return NextResponse.json({
      keys: keys.map((key) => ({ ...key, accessTags: accessTagsByKey[key.id] || [], quota: quotaStatuses[key.id] })),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
