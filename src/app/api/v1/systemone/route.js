import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { handleSystemone } from "@/sse/handlers/systemone.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  return withNetworkTraffic(request, (monitoredRequest) => handleSystemone(monitoredRequest));
}
