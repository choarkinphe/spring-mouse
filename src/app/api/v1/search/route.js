import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { handleSearch } from "@/sse/handlers/search.js";

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
 * POST /v1/search - Web search endpoint
 */
async function handlePOST(request) {
  return await handleSearch(request);
}


export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handlePOST(monitoredRequest));
}
