import { getCombos } from "@/lib/localDb";

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
export async function GET() {
  try {
    const combos = await getCombos();

    return Response.json({
      models: combos
        .filter((combo) => combo.isActive !== false && Array.isArray(combo.models) && combo.models.length > 0)
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
