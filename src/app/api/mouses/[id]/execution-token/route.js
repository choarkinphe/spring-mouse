import { NextResponse } from "next/server";
import { rotateMouseExecutionToken } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const result = await rotateMouseExecutionToken(id);
    if (!result) {
      return NextResponse.json(
        { error: "Mouse not found or disabled" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to rotate mouse execution token:", error);
    return NextResponse.json(
      { error: "Failed to rotate execution token" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
