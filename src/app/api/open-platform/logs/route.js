import { NextResponse } from "next/server";
import { getOpenPlatformApiCallLogs } from "@/lib/localDb";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get("page") || 1);
    const pageSize = Number(searchParams.get("pageSize") || 30);
    const apiKeyId = searchParams.get("apiKeyId") || null;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return NextResponse.json({ error: "Invalid pagination" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (apiKeyId && apiKeyId.length > 128) {
      return NextResponse.json({ error: "Invalid API key filter" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(await getOpenPlatformApiCallLogs({ apiKeyId, page, pageSize }), { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to list open platform call logs:", error);
    return NextResponse.json({ error: "Failed to list open platform call logs" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
