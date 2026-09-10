import { NextResponse } from "next/server";
import { authenticateMouseAccessToken, updateMouseHeartbeat } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request) {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const authenticated = await authenticateMouseAccessToken(token);
    if (!authenticated) {
      return NextResponse.json({ error: "Mouse access token is invalid or disabled" }, { status: 401, headers: NO_STORE_HEADERS });
    }

    const body = await request.json().catch(() => ({}));
    const mouse = await updateMouseHeartbeat(authenticated.id, {
      version: body?.version,
      capabilities: body?.capabilities,
      metadata: body?.metadata,
    });
    if (!mouse) {
      return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ mouse, heartbeatIntervalSeconds: 30 }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to record mouse heartbeat:", error);
    return NextResponse.json({ error: "Failed to record heartbeat" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
