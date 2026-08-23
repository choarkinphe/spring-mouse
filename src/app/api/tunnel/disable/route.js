import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";
import { stopCloudflareTunnel } from "@/lib/tunnel/cloudflare/cloudflared";
import { stopCloudflareTunnelSupervisor } from "@/shared/services/cloudflareTunnelSupervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    // Stop monitoring first so it cannot race the persisted disabled state and
    // bring the child process back while this request is completing.
    stopCloudflareTunnelSupervisor();
    const tunnel = await stopCloudflareTunnel();
    const settings = await updateSettings({
      cloudflareTunnelEnabled: false,
      tunnelEnabled: false,
      tunnelUrl: "",
    });
    return NextResponse.json({
      tunnel,
      settings: {
        cloudflareTunnelEnabled: settings.cloudflareTunnelEnabled,
        tunnelEnabled: settings.tunnelEnabled,
        tunnelUrl: settings.tunnelUrl,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
