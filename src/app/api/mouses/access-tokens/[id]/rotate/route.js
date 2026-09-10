import { NextResponse } from "next/server";
import { rotateMouseAccessToken } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const ttlSeconds = body?.ttlSeconds === null || body?.ttlSeconds === 0
      ? null
      : Number(body?.ttlSeconds);
    if (ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86400 * 365)) {
      return NextResponse.json({ error: "TTL must be permanent, 0, or between 30 seconds and 365 days" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const result = await rotateMouseAccessToken(id, { ttlSeconds });
    if (!result) {
      return NextResponse.json({ error: "Access token not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to rotate mouse access token:", error);
    return NextResponse.json({ error: "Failed to rotate access token" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
