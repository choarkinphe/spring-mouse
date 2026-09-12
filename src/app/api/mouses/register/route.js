import { NextResponse } from "next/server";
import { registerMouse } from "@/lib/localDb";
import { getTrustedSourceIp } from "@/shared/utils/requestSource";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

// The agent authenticates with the token that shipped inside its start command;
// that token already belongs to a node, so registration never creates rows — it
// claims the row the dashboard provisioned. The agent's own clientId is ignored
// on purpose: the token is the identity, so a sloppy agent cannot claim a second
// row or collide with an existing node.
export async function POST(request) {
  try {
    const body = await request.json();
    const mouseToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || body?.mouseToken;
    const result = await registerMouse({
      mouseToken,
      version: body?.version,
      capabilities: body?.capabilities,
      metadata: body?.metadata,
      registrationIp: getTrustedSourceIp(request),
      callbackUrl: body?.callbackUrl,
    });

    if (result?.error) {
      if (result.error === "invalid_callback_url") {
        return NextResponse.json({ error: "callbackUrl must be a valid HTTP or HTTPS URL" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      if (result.error === "mouse_disabled") {
        return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
      }
      return NextResponse.json({ error: "Mouse access token is invalid" }, { status: 401, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(result, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to register mouse:", error);
    return NextResponse.json({ error: "Failed to register mouse" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
