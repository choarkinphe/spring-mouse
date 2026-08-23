import { NextResponse } from "next/server";
import { getSystemStatus } from "@/lib/system/status";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSystemStatus(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
