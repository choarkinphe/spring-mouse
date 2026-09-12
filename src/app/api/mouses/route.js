import { NextResponse } from "next/server";
import { createMouseAccessToken, getMouseAccessTokens, getMouses } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

// Aggregated at the API boundary on purpose: the node list only needs to *show*
// how much work each node carries, and keeping it here leaves the routing-side
// repository (getMouses) untouched. A node that loses its accounts reports 0.
async function withBoundAccountCounts(mouses) {
  try {
    const db = await getAdapter();
    const rows = await db.all(
      "SELECT mouseId, COUNT(*) AS total FROM providerConnections WHERE mouseId IS NOT NULL AND mouseId != '' GROUP BY mouseId",
    );
    const counts = new Map(rows.map((row) => [row.mouseId, Number(row.total) || 0]));
    return mouses.map((mouse) => ({ ...mouse, boundAccountCount: counts.get(mouse.id) || 0 }));
  } catch (error) {
    console.error("[API] Failed to count mouse bound accounts:", error);
    return mouses.map((mouse) => ({ ...mouse, boundAccountCount: 0 }));
  }
}

export async function GET() {
  try {
    const [mouses, accessTokens] = await Promise.all([
      getMouses(),
      getMouseAccessTokens(),
    ]);
    return NextResponse.json(
      { mouses: await withBoundAccountCounts(mouses), accessTokens },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[API] Failed to list mouses:", error);
    return NextResponse.json({ error: "Failed to list mouses" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const ttlSeconds = body?.ttlSeconds === null || body?.ttlSeconds === 0
      ? null
      : Number(body?.ttlSeconds);
    if (name.length > 80) {
      return NextResponse.json({ error: "Name must be at most 80 characters" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86400 * 365)) {
      return NextResponse.json({ error: "TTL must be permanent, 0, or between 30 seconds and 365 days" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const accessToken = await createMouseAccessToken({ name, ttlSeconds });
    return NextResponse.json({ accessToken }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to create mouse registration token:", error);
    return NextResponse.json({ error: "Failed to create registration token" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
