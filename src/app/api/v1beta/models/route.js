import { withNetworkTraffic } from "@/lib/networkTraffic.js";
import { getCombos, getSettings } from "@/lib/localDb";
import { authorizeApiKey, extractApiKey, resolveApiKeyAccessTags } from "@/sse/services/auth.js";
import { canAccessWithTags } from "@/shared/utils/accessTags";
import { getActiveComboModels } from "open-sse/services/combo.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Exposes configured combo routing entrypoints only.
 */
async function handleGET(request) {
  try {
    const apiKey = extractApiKey(request);
    const settings = await getSettings();
    const authFailure = await authorizeApiKey(apiKey, { requireApiKey: settings.requireApiKey === true });
    if (authFailure) return authFailure;
    const accessTags = await resolveApiKeyAccessTags(apiKey);
    const combos = await getCombos();

    return Response.json({
      models: combos
        .filter((combo) => {
          if (combo.isActive === false || !Array.isArray(combo.models) || combo.models.length === 0) return false;
          if (!canAccessWithTags(accessTags, combo.accessTags)) return false;
          const activeComboModels = getActiveComboModels(combo.models, new Date(), accessTags);
          return Array.isArray(activeComboModels) && activeComboModels.length > 0;
        })
        .map((combo) => ({
        name: `models/${combo.name}`,
        displayName: combo.name,
        description: "Configured routing combo",
        ...(Number.isInteger(combo.capabilities?.contextWindow) && combo.capabilities.contextWindow > 0 ? { inputTokenLimit: combo.capabilities.contextWindow } : {}),
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      })),
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}


export async function GET(request = new Request("http://localhost/api/v1beta/models")) {
  return withNetworkTraffic(request, () => handleGET(request));
}
