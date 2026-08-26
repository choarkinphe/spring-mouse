import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { handleTts } from "@/sse/handlers/tts.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/audio/speech - OpenAI-compatible TTS endpoint */
async function handlePOST(request) {
  return await handleTts(request);
}


export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handlePOST(monitoredRequest));
}
