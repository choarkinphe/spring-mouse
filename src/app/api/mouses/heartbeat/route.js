import { NextResponse } from "next/server";
import { getMouseByAccessToken, updateMouseHeartbeat } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

// The token identifies the node, so the heartbeat no longer has to look the node
// up by clientId. The reported clientId is informational only.
export async function POST(request) {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const mouse = await getMouseByAccessToken(token);
    if (!mouse) {
      return NextResponse.json({ error: "Mouse access token is invalid" }, { status: 401, headers: NO_STORE_HEADERS });
    }
    if (mouse.disabledAt) {
      return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const body = await request.json().catch(() => ({}));
    const reportedClientId = request.headers.get("x-mouse-client-id")?.trim() || body?.clientId;
    if (reportedClientId && reportedClientId !== mouse.clientId) {
      // Usually one start command pasted onto two hosts: both would drive the same
      // node identity. Worth a log line, not a failure.
      console.warn(`[API] Mouse heartbeat clientId mismatch: node ${mouse.clientId}, reported ${reportedClientId}`);
    }

    const updated = await updateMouseHeartbeat(mouse.clientId, {
      version: body?.version,
      capabilities: body?.capabilities,
      metadata: body?.metadata,
    });
    if (!updated) {
      return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ mouse: updated, heartbeatIntervalSeconds: 30 }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to record mouse heartbeat:", error);
    return NextResponse.json({ error: "Failed to record heartbeat" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
