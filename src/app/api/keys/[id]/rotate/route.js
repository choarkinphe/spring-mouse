import { NextResponse } from "next/server";
import { getApiKeyById, updateApiKey } from "@/lib/localDb";
import { generateApiKeyWithMachine } from "@/shared/utils/apiKey";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

// POST /api/keys/[id]/rotate - Replace only the secret, preserving the key ID.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    const { key } = generateApiKeyWithMachine(existing.machineId);
    // updateApiKey invalidates the old authentication and quota caches too.
    const updated = await updateApiKey(id, { key });
    if (!updated) {
      return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ key: updated }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "Failed to rotate key" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
