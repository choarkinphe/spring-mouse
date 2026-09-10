import { NextResponse } from "next/server";
import { deleteMouseAccessToken } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteMouseAccessToken(id);
    if (!deleted) {
      return NextResponse.json({ error: "Access token not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ deleted: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to delete mouse access token:", error);
    return NextResponse.json({ error: "Failed to delete access token" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
