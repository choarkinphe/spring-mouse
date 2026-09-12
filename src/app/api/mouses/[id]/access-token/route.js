import { NextResponse } from "next/server";
import { rotateMouseToken } from "@/lib/localDb";
import { disconnectTunnel } from "@/lib/mouse/tunnel";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

// Re-issues the node's own access token and returns the plaintext once, so the
// start command can be handed out again (or re-created after a name change).
// Whatever token the node was given before stops working immediately — and so
// does the tunnel it was holding, otherwise the old agent would sit on a
// connection nothing can address any more.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const result = await rotateMouseToken(id);
    if (!result) {
      return NextResponse.json({ error: "Mouse not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    disconnectTunnel(id, "access token rotated");
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to rotate mouse access token:", error);
    return NextResponse.json({ error: "Failed to rotate access token" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
