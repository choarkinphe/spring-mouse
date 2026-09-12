import { NextResponse } from "next/server";
import { deleteMouse, updateMouse } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const updates = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) {
        return NextResponse.json({ error: "Name must be between 1 and 80 characters" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      updates.name = body.name;
    }
    if (body.disabled !== undefined) updates.disabled = body.disabled === true;
    if (body.callbackUrl !== undefined) updates.callbackUrl = body.callbackUrl;
    if (!Object.keys(updates).length) {
      return NextResponse.json({ error: "No supported fields provided" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const result = await updateMouse(id, updates);
    if (result?.validationError) {
      return NextResponse.json({ error: result.validationError }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (!result?.mouse) {
      return NextResponse.json({ error: "Mouse not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ mouse: result.mouse }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to update mouse:", error);
    return NextResponse.json({ error: "Failed to update mouse" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteMouse(id);
    if (!deleted) {
      return NextResponse.json({ error: "Mouse not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ deleted: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to delete mouse:", error);
    return NextResponse.json({ error: "Failed to delete mouse" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
