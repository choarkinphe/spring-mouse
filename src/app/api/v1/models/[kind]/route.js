import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { buildModelsList } from "../route.js";
import { getSettings } from "@/lib/localDb";
import { authorizeApiKey, extractApiKey, resolveApiKeyAccessTags } from "@/sse/services/auth.js";

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web.
 */
async function handleGET(request, { params }) {
  try {
    const { kind } = await params;
    const kindFilter = KIND_SLUG_MAP[kind];

    if (!kindFilter) {
      return Response.json(
        {
          error: {
            message: `Unknown model kind: ${kind}. Supported: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const apiKey = extractApiKey(request);
    const settings = await getSettings();
    const authFailure = await authorizeApiKey(apiKey, { requireApiKey: settings.requireApiKey === true });
    if (authFailure) return authFailure;
    const accessTags = await resolveApiKeyAccessTags(apiKey);
    const data = await buildModelsList(kindFilter, { accessTags });
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models by kind:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}


export async function GET(request, context) {
  return withNetworkTraffic(request, (monitoredRequest) => handleGET(monitoredRequest, context));
}
