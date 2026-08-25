import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import {
  getCloudflareTunnelStatus,
  refreshCloudflareTunnelConnection,
} from "@/lib/tunnel/cloudflare/cloudflared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    await refreshCloudflareTunnelConnection();
    return NextResponse.json(getCloudflareTunnelStatus(settings), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
