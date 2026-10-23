// Registry seeds and third-party capability catalogs are not discovery sources.
export const OFFICIAL_MODEL_CATALOG = {
  minimax: { url: "https://api.minimax.io/v1/models", auth: "bearer", scope: "account" },
  "minimax-cn": { url: "https://api.minimaxi.com/v1/models", auth: "bearer", scope: "account" },
  venice: { url: "https://api.venice.ai/api/v1/models", auth: "none", scope: "public" },
  tokenrouter: { url: "https://api.tokenrouter.com/v1/models", auth: "bearer", scope: "account" },
  kilocode: { url: "https://api.kilo.ai/api/gateway/models", auth: "none", scope: "public" },
  "kilo-gateway": { url: "https://api.kilo.ai/api/gateway/models", auth: "none", scope: "public" },
  cline: { url: "https://api.cline.bot/api/v1/models", auth: "none", scope: "public" },
  sambanova: { url: "https://api.sambanova.ai/v1/models", auth: "none", scope: "public" },
  opencode: { url: "https://opencode.ai/zen/v1/models", auth: "none", scope: "public", filter: "opencode-free" },

  // https://mimo.mi.com/static/docs/api/model/list-models.md
  // Documents Bearer (or api-key) auth at this API host, not Token Plan hosts.
  "xiaomi-mimo": { url: "https://api.xiaomimimo.com/v1/models", auth: "bearer", scope: "account" },

  // https://fal.ai/docs/platform-apis/v1/models
  // Authentication is optional. Follow next_cursor via the cursor query parameter
  // until has_more=false; a first page is not a complete official directory.
  "fal-ai": { url: "https://api.fal.ai/v1/models", auth: "none", scope: "public", shape: "fal", pagination: "fal-cursor" },

  // https://developers.deepgram.com/reference/manage/models/list
  // Authorization: Token <key>; stt[] and tts[] use canonical_name identifiers.
  deepgram: { url: "https://api.deepgram.com/v1/models", auth: "token", scope: "account", shape: "deepgram" },

  // https://elevenlabs.io/docs/api-reference/models/list
  // https://elevenlabs.io/docs/api-reference/authentication
  // Bare array of model_id objects, NOT the separate /voices directory.
  elevenlabs: { url: "https://api.elevenlabs.io/v1/models", auth: "xi-api-key", scope: "account" },
};

// Deliberately not inferred from OpenAI compatibility or a 401 response:
// Xiaomi Token Plan regional hosts, GLM global/CN Coding Plan, Kimi Code, and
// Alibaba international Coding Plan have no verified model-list route here.
// Fish /model lists voices; BFL/Runway/Recraft have no verified model directory.
