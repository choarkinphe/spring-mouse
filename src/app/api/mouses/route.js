import { NextResponse } from "next/server";
import { createMouse, getMouses } from "@/lib/localDb";
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
    const mouses = await getMouses();
    return NextResponse.json(
      { mouses: await withBoundAccountCounts(mouses) },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[API] Failed to list mouses:", error);
    return NextResponse.json({ error: "Failed to list mouses" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

// Creating a node is all it takes to enrol it: the row is inserted up front (so it
// shows as 未注册 in the board) together with the access token that its start
// command will carry. The plaintext token is returned exactly once.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await createMouse({ name: body?.name });
    if (result?.validationError) {
      return NextResponse.json({ error: result.validationError }, { status: 400, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(
      { mouse: result.mouse, token: result.token },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[API] Failed to create mouse:", error);
    return NextResponse.json({ error: "Failed to create mouse" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
