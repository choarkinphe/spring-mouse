import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { handleVideoCreate } from "@/sse/handlers/videoGeneration.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/videos/generations - async video generation (xAI Grok Imagine) */
async function handlePOST(request) {
  return await handleVideoCreate(request, "generations");
}


export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handlePOST(monitoredRequest));
}
