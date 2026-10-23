import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { discoverConnectionModels } from "@/lib/services/officialModelDiscovery";

/** GET /api/providers/[id]/models — official directory, never a static fallback. */
export async function GET(request, { params }) {
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection) return NextResponse.json({ error: "Connection not found", discovery: { status: "failed", source: "official" } }, { status: 404 });
  const result = await discoverConnectionModels(connection);
  if (result.error) {
    return NextResponse.json({ error: result.error, discovery: { status: result.unsupported ? "unsupported" : "failed", source: "official" } }, { status: result.status || 502 });
  }
  return NextResponse.json(result);
}
