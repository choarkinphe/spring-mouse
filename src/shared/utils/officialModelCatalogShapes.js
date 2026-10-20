import { parseOfficialModelPayload } from "./officialModelDiscovery.js";

const INVALID_LIST = "Upstream returned an invalid model list";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// https://fal.ai/docs/platform-apis/v1/models
// This parses ONE page, not a complete directory. The caller must follow the
// opaque nextCursor with URL.searchParams.set("cursor", nextCursor), retaining
// the original endpoint/filters, and reject repeated cursors or page exhaustion.
export function parseFalModelPage(data) {
  if (!isRecord(data) || !Array.isArray(data.models) || typeof data.has_more !== "boolean") {
    throw new Error(INVALID_LIST);
  }
  const nextCursor = data.next_cursor ?? null;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor.trim() || nextCursor !== nextCursor.trim())) {
    throw new Error(INVALID_LIST);
  }
  // has_more is documented as derived from next_cursor. Never silently accept
  // a truncated page or treat an inconsistent termination signal as complete.
  if (data.has_more !== (nextCursor !== null)) throw new Error(INVALID_LIST);
  const models = parseOfficialModelPayload({
    ...data,
    data: data.models.map((model) => isRecord(model) ? {
      ...model,
      id: model.endpoint_id ?? "",
      name: model.metadata?.display_name || model.endpoint_id,
    } : null),
  });
  return { models, nextCursor };
}

// https://developers.deepgram.com/reference/manage/models/list
// canonical_name is the inference-facing identifier: TTS name="zeus" is only
// a voice label, whereas canonical_name="aura-2-zeus-en" is the model selector.
// https://developers.deepgram.com/docs/tts-models
export function parseDeepgramModels(data) {
  if (!isRecord(data) || data.err_code || data.err_msg || (data.stt === undefined && data.tts === undefined)) {
    throw new Error(INVALID_LIST);
  }
  const models = [];
  for (const kind of ["stt", "tts"]) {
    if (data[kind] === undefined) continue;
    if (!Array.isArray(data[kind])) throw new Error(INVALID_LIST);
    models.push(...data[kind].map((model) => isRecord(model) ? {
      ...model,
      id: model.canonical_name ?? "",
      name: model.name || model.canonical_name,
      kind,
    } : null));
  }
  return parseOfficialModelPayload({ ...data, data: models });
}

// Keep the existing OpenAI-compatible parser (including model_id array support)
// authoritative for normal providers. Pagination remains the service's concern.
export function parseOfficialCatalogModels(data, shape = "openai") {
  if (shape === "fal") return parseFalModelPage(data).models;
  if (shape === "deepgram") return parseDeepgramModels(data);
  return parseOfficialModelPayload(data, shape);
}
