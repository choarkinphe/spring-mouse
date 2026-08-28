import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { authenticateOpenPlatformRequest } from "@/lib/openPlatform/auth";
import { recordOpenPlatformRequest } from "@/lib/openPlatform/callLogging";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export const dynamic = "force-dynamic";

function authError(code) {
  const message = code === "missing_api_key"
    ? "Provide an open platform API key with Authorization: Bearer <key> or x-api-key."
    : "The open platform API key is invalid or disabled.";
  return NextResponse.json({ error: { code, message } }, { status: 401, headers: NO_STORE_HEADERS });
}

export async function GET(request) {
  const startedAt = Date.now();
  let credential = null;
  try {
    const auth = await authenticateOpenPlatformRequest(request);
    if (auth.error) return authError(auth.error);
    credential = auth.credential;

    const keys = await getApiKeys();
    const response = NextResponse.json({
      object: "list",
      data: keys.map((key) => ({
        userId: key.id,
        name: key.name || "Unnamed user",
        active: key.isActive && key.quotaMode !== "off",
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt || null,
      })),
    }, { headers: NO_STORE_HEADERS });
    return await recordOpenPlatformRequest({ credential, request, response, startedAt });
  } catch (error) {
    console.error("[OPEN API] Failed to list report users:", error);
    const response = NextResponse.json({ error: { code: "user_list_failed", message: "Failed to list report users." } }, { status: 500, headers: NO_STORE_HEADERS });
    return await recordOpenPlatformRequest({ credential, request, response, startedAt });
  }
}
