import { NextResponse } from "next/server";
import { getDestinationsView, activateDestination, destinationErrorStatus } from "@/lib/backup/destinationsStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };

// POST /api/settings/backup/destinations/[id]/activate — make this destination
// the one replicating. litestream allows a single replica per database, so the
// engine replaces its child rather than adding a second.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    await activateDestination(id);
    return NextResponse.json(
      { ok: true, destinations: (await getDestinationsView()).destinations },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: destinationErrorStatus(error) });
  }
}
