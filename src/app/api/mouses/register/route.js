import { NextResponse } from "next/server";
import { registerMouse } from "@/lib/localDb";
import { getTrustedSourceIp } from "@/shared/utils/requestSource";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request) {
  try {
    const body = await request.json();
    const result = await registerMouse({
      registrationToken: body?.registrationToken,
      name: typeof body?.name === "string" ? body.name : "",
      version: body?.version,
      capabilities: body?.capabilities,
      metadata: body?.metadata,
      registrationIp: getTrustedSourceIp(request),
    });

    if (result?.error) {
      return NextResponse.json({ error: "Registration token is invalid, expired, or already used" }, { status: 401, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(result, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to register mouse:", error);
    return NextResponse.json({ error: "Failed to register mouse" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
