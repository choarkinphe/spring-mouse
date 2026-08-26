import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/images/generations - OpenAI-compatible image generation endpoint */
async function handlePOST(request) {
  return await handleImageGeneration(request);
}


export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handlePOST(monitoredRequest));
}
