import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { startCloudflareTunnel } from "@/lib/tunnel/cloudflare/cloudflared";
import { startCloudflareTunnelSupervisor } from "@/shared/services/cloudflareTunnelSupervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const settings = await getSettings();
    const tunnel = await startCloudflareTunnel(settings);
    const updatedSettings = await updateSettings({
      cloudflareTunnelEnabled: true,
      tunnelEnabled: true,
      tunnelProvider: "cloudflare",
      tunnelUrl: tunnel.publicUrl || settings.cloudflareTunnelPublicUrl || "",
    });
    startCloudflareTunnelSupervisor();
    return NextResponse.json({
      tunnel,
      settings: {
        cloudflareTunnelEnabled: updatedSettings.cloudflareTunnelEnabled,
        tunnelEnabled: updatedSettings.tunnelEnabled,
        tunnelProvider: updatedSettings.tunnelProvider,
        tunnelUrl: updatedSettings.tunnelUrl,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
