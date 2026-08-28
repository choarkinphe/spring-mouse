import { authenticateOpenPlatformApiKey } from "@/lib/localDb";

export function extractOpenPlatformApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  const bearerMatch = authHeader?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]?.trim()) return bearerMatch[1].trim();

  const headerKey = request.headers.get("x-api-key") || request.headers.get("api-key");
  return headerKey?.trim() || null;
}

export async function authenticateOpenPlatformRequest(request) {
  const key = extractOpenPlatformApiKey(request);
  if (!key) return { credential: null, error: "missing_api_key" };
  const credential = await authenticateOpenPlatformApiKey(key);
  return credential
    ? { credential, error: null }
    : { credential: null, error: "invalid_api_key" };
}
