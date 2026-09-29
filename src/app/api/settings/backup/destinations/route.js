import { NextResponse } from "next/server";
import { getDestinationsView, createDestination, destinationErrorStatus } from "@/lib/backup/destinationsStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };

// GET /api/settings/backup/destinations — the saved destinations (secret-free).
export async function GET() {
  try {
    return NextResponse.json(await getDestinationsView(), { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST — add a destination. `{ type, label, config, secret }`. The first one
// added becomes active, so saving is enough to start replicating.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    await createDestination(body);
    return NextResponse.json(
      { ok: true, destinations: (await getDestinationsView()).destinations },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: destinationErrorStatus(error) });
  }
}
