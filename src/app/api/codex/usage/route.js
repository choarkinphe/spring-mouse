import { NextResponse } from "next/server";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth.js";
import { buildCodexUsagePayload, getApiKeyQuotaStatus } from "@/lib/apiKeyQuota";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export function OPTIONS() {
  return new Response(null, {
    headers: {
      ...RESPONSE_HEADERS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");

  // Usage is key-specific, so this compatibility endpoint requires a known key
  // even when the router itself permits anonymous local model requests.
  if (!(await isValidApiKey(apiKey))) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  const status = await getApiKeyQuotaStatus(apiKey);
  if (!status) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");

  return NextResponse.json(buildCodexUsagePayload(status), { headers: RESPONSE_HEADERS });
}
