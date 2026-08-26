import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { handleEmbeddings } from "@/sse/handlers/embeddings.js";

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
 * POST /v1/embeddings - OpenAI-compatible embeddings endpoint
 */
async function handlePOST(request) {
  return await handleEmbeddings(request);
}


export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handlePOST(monitoredRequest));
}
