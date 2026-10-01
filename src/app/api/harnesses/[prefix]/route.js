import { NextResponse } from "next/server";
import { saveHarnessSettings } from "@/lib/harnessSettings";

export async function PATCH(request, { params }) {
  const { prefix } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const result = await saveHarnessSettings(prefix, body);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!error.status) console.error("Failed to save harness:", error);
    return NextResponse.json({ error: error.status ? error.message : "Failed to save harness" }, {
      status: error.status || 500,
    });
  }
}
