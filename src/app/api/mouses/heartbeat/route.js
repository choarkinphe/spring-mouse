import { NextResponse } from "next/server";
import { authenticateMouseAccessToken, getMouseByClientId, updateMouseHeartbeat } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request) {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const accessToken = await authenticateMouseAccessToken(token);
    if (!accessToken) {
      return NextResponse.json({ error: "Mouse access token is invalid or expired" }, { status: 401, headers: NO_STORE_HEADERS });
    }

    const body = await request.json().catch(() => ({}));
    const clientId = request.headers.get("x-mouse-client-id")?.trim() || body?.clientId;
    const mouse = await getMouseByClientId(clientId);
    if (!mouse) {
      return NextResponse.json({ error: "clientId is not registered" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    const updated = await updateMouseHeartbeat(mouse.clientId, {
      version: body?.version,
      capabilities: body?.capabilities,
      metadata: body?.metadata,
    });
    if (!mouse) {
      return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
    }
    if (!updated) {
      return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ mouse: updated, heartbeatIntervalSeconds: 30 }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to record mouse heartbeat:", error);
    return NextResponse.json({ error: "Failed to record heartbeat" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
