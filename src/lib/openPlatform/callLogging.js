import { normalizeIp } from "@/lib/auth/ipAccess";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import { recordOpenPlatformApiCall } from "@/lib/localDb";

function getSourceIp(request) {
  if (!hasTrustedPeerHeaders(request)) return null;
  return normalizeIp(request.headers.get("x-sm-real-ip") || request.headers.get("x-9r-real-ip"));
}

function normalizeOpenPath(request) {
  try {
    return new URL(request.url).pathname.replace(/^\/api\/open\/v1(?=\/|$)/, "/open/v1");
  } catch {
    return "/open/v1";
  }
}

export async function recordOpenPlatformRequest({ credential, request, response, startedAt, subjectUserId = null }) {
  if (!credential) return response;
  try {
    await recordOpenPlatformApiCall({
      apiKeyId: credential.id,
      keyName: credential.name,
      keyPrefix: credential.keyPrefix,
      method: request.method || "GET",
      path: normalizeOpenPath(request),
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      sourceIp: getSourceIp(request),
      userAgent: request.headers.get("user-agent")?.slice(0, 256) || null,
      subjectUserId,
    });
  } catch (error) {
    console.error("[OPEN API] Failed to record call log:", error);
  }
  return response;
}
