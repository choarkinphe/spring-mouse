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

/** POST /v1/videos/extensions - async video extension (xAI Grok Imagine) */
async function handlePOST(request) {
  return await handleVideoCreate(request, "extensions");
}


export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handlePOST(monitoredRequest));
}
