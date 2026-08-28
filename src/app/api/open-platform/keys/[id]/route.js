import { NextResponse } from "next/server";
import { deleteOpenPlatformApiKey, updateOpenPlatformApiKey } from "@/lib/localDb";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const updates = {};

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 80) {
        return NextResponse.json({ error: "Name must be between 1 and 80 characters" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      updates.name = name;
    }
    if (body.isActive !== undefined) updates.isActive = body.isActive === true;
    if (!Object.keys(updates).length) {
      return NextResponse.json({ error: "No supported fields provided" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const key = await updateOpenPlatformApiKey(id, updates);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE_HEADERS });
    return NextResponse.json({ key }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to update open platform key:", error);
    return NextResponse.json({ error: "Failed to update open platform key" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteOpenPlatformApiKey(id);
    if (!deleted) return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE_HEADERS });
    return NextResponse.json({ deleted: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to delete open platform key:", error);
    return NextResponse.json({ error: "Failed to delete open platform key" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
