import { NextResponse } from "next/server";
import { createOpenPlatformApiKey, getOpenPlatformApiKeys } from "@/lib/localDb";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ keys: await getOpenPlatformApiKeys() }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to list open platform keys:", error);
    return NextResponse.json({ error: "Failed to list open platform keys" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) {
      return NextResponse.json({ error: "Name must be between 1 and 80 characters" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const created = await createOpenPlatformApiKey(name);
    return NextResponse.json({ key: created }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to create open platform key:", error);
    return NextResponse.json({ error: "Failed to create open platform key" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
