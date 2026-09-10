import { NextResponse } from "next/server";
import { registerMouse } from "@/lib/localDb";
import { getTrustedSourceIp } from "@/shared/utils/requestSource";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request) {
  try {
    const body = await request.json();
    const mouseToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || body?.mouseToken;
    const result = await registerMouse({
      mouseToken,
      clientId: body?.clientId,
      name: typeof body?.name === "string" ? body.name : "",
      version: body?.version,
      capabilities: body?.capabilities,
      metadata: body?.metadata,
      registrationIp: getTrustedSourceIp(request),
      callbackUrl: body?.callbackUrl,
    });

    if (result?.error) {
      if (result.error === "invalid_client_id") {
        return NextResponse.json({ error: "clientId is required and may contain letters, numbers, dot, underscore, colon, @, hyphen" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      if (result.error === "invalid_callback_url") {
        return NextResponse.json({ error: "callbackUrl must be a valid HTTP or HTTPS URL" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      if (result.error === "client_id_disabled") {
        return NextResponse.json({ error: "clientId is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
      }
      return NextResponse.json({ error: "Mouse access token is invalid or expired" }, { status: 401, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(result, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to register mouse:", error);
    return NextResponse.json({ error: "Failed to register mouse" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
