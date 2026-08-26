import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { handleFetch } from "@/sse/handlers/fetch.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/web/fetch - Web URL fetch/extract endpoint
 */
async function handlePOST(request) {
  return await handleFetch(request);
}


export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handlePOST(monitoredRequest));
}
