// JevAPI / TypeSafe "System One" — a NATIVE (non-chat) evaluation service.
// POST /v1/systemone { model, state, questions } → { model, answers, usage }
// Docs: https://docs.typesafe.ai/api.md · Console: https://console.typesafe.ai

export const JEVAPI_PROVIDER_ID = "jevapi";

// Known aliases/version for routing and pricing, not evidence of account access.
export const JEVAPI_STATIC_MODELS = ["jev-latest", "jev-preview", "jev-1.13.0"];

// Question types accepted by the evaluation endpoint (each Answer echoes its type).
export const JEVAPI_QUESTION_TYPES = {
  NOUL: "noul",
  CHOICE: "choice",
  SCORE: "score",
};

export const JEVAPI_CONFIG = {
  provider: JEVAPI_PROVIDER_ID,
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  modelsUrl: "https://api.typesafe.ai/v1/models",
  defaultModel: "jev-latest",
  authHeader: "Authorization",
  authScheme: "bearer",
  // USD / 1M tokens. System One does not bill output separately; keep 0.
  pricing: { input: 0.042, output: 0 },
  questionTypes: JEVAPI_QUESTION_TYPES,
  staticModels: JEVAPI_STATIC_MODELS,
};

// Parse upstream `{ models: [{ name, description, release_date }] }`. `name` is the
// model id; `type` stays "systemone" so a synced model is never treated as chat.
export function parseJevapiModels(payload) {
  const raw = Array.isArray(payload) ? payload : payload?.models;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const models = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry : (entry?.name || entry?.id);
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      type: "systemone",
      // No chat features; keeps dashboards from showing it as tool/chat capable.
      capabilities: { tools: false },
      ...(entry?.description ? { description: entry.description } : {}),
      ...(entry?.release_date ? { releaseDate: entry.release_date } : {}),
    });
  }
  return models;
}
