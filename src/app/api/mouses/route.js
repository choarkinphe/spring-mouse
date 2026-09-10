import { NextResponse } from "next/server";
import { createMouseRegistrationToken, getMouseRegistrationTokens, getMouses } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function GET() {
  try {
    const [mouses, registrationTokens] = await Promise.all([
      getMouses(),
      getMouseRegistrationTokens(),
    ]);
    return NextResponse.json({ mouses, registrationTokens }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to list mouses:", error);
    return NextResponse.json({ error: "Failed to list mouses" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const ttlSeconds = Number(body?.ttlSeconds ?? 600);
    if (name.length > 80) {
      return NextResponse.json({ error: "Name must be at most 80 characters" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86400) {
      return NextResponse.json({ error: "TTL must be between 30 and 86400 seconds" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const registrationToken = await createMouseRegistrationToken({ name, ttlSeconds });
    return NextResponse.json({ registrationToken }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to create mouse registration token:", error);
    return NextResponse.json({ error: "Failed to create registration token" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
