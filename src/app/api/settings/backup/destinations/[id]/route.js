import { NextResponse } from "next/server";
import {
  getDestinationsView,
  editDestination,
  deleteDestination,
  destinationErrorStatus,
} from "@/lib/backup/destinationsStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };

// PATCH — edit label / config / secret. A BLANK secret field means "keep the
// stored credential" (the same convention as cloudflareTunnelToken), so the
// edit drawer can be submitted without re-typing a password.
export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    await editDestination(id, body);
    return NextResponse.json(
      { ok: true, destinations: (await getDestinationsView()).destinations },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: destinationErrorStatus(error) });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    await deleteDestination(id);
    return NextResponse.json(
      { ok: true, destinations: (await getDestinationsView()).destinations },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: destinationErrorStatus(error) });
  }
}
