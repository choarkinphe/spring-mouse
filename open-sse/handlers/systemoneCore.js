import { JEVAPI_CONFIG, JEVAPI_QUESTION_TYPES } from "../config/jevapi.js";
import { FETCH_CONNECT_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.js";
import { combineWithTimeout } from "../utils/abortable.js";
import { createErrorResult, parseUpstreamError } from "../utils/error.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isContent = (value) => typeof value === "string" || (value !== null && typeof value === "object");

export function validateSystemoneRequest(body) {
  if (!isObject(body)) return "Request body must be an object";
  if (typeof body.model !== "string" || !body.model.trim()) return "Missing required field: model";
  if (!isContent(body.state)) return "state must be a string, object, or array";
  if (body.stream === true) return "System One does not support streaming";
  if (!isObject(body.questions) || Object.keys(body.questions).length === 0) return "questions must be a non-empty map";
  for (const [id, question] of Object.entries(body.questions)) {
    if (!isObject(question) || !isContent(question.instructions)) return `Question '${id}' requires instructions (string, object, or array)`;
    const { type, criteria } = question;
    if (type === JEVAPI_QUESTION_TYPES.NOUL) {
      if (criteria !== undefined && (!isObject(criteria) || Object.entries(criteria).some(([key, value]) => !["true", "false"].includes(key) || !isContent(value)))) {
        return `Question '${id}' has invalid noul criteria`;
      }
    } else if (type === JEVAPI_QUESTION_TYPES.CHOICE) {
      if (!isObject(criteria) || Object.keys(criteria).length === 0 || Object.keys(criteria).length > 255 || Object.values(criteria).some((value) => value !== null && !isContent(value))) {
        return `Question '${id}' requires 1–255 choice options`;
      }
    } else if (type === JEVAPI_QUESTION_TYPES.SCORE) {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || criteria.some((value) => !isContent(value))) {
        return `Question '${id}' requires 2–10 score levels`;
      }
    } else {
      return `Question '${id}' type must be noul, choice, or score`;
    }
  }
  return null;
}

export async function handleSystemoneCore({ body, modelInfo, credentials, signal }) {
  const invalid = validateSystemoneRequest(body);
  if (invalid) return createErrorResult(HTTP_STATUS.BAD_REQUEST, invalid);
  if (modelInfo.provider !== JEVAPI_CONFIG.provider) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "This provider does not support System One");
  }
  if (!credentials.apiKey) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing JevAPI API key");

  const fetchSignal = combineWithTimeout(signal, FETCH_CONNECT_TIMEOUT_MS);
  try {
    const upstream = await fetch(JEVAPI_CONFIG.baseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelInfo.model, state: body.state, questions: body.questions }),
      signal: fetchSignal,
    });
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    if (!upstream.ok) {
      const text = await upstream.text();
      const { statusCode, message, upstreamError } = await parseUpstreamError(new Response(text, { status: upstream.status, headers: upstream.headers }));
      const result = createErrorResult(statusCode, message, undefined, upstreamError);
      try {
        JSON.parse(text);
        // Preserve native validation details, not upstream cookies or other headers.
        result.response = new Response(text, { status: statusCode, headers });
      } catch {
        if (retryAfter) result.response.headers.set("Retry-After", retryAfter);
      }
      return result;
    }
    let data;
    try {
      data = await upstream.json();
    } catch (error) {
      if (fetchSignal?.aborted) throw error;
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid JSON response from JevAPI");
    }
    if (!isObject(data) || typeof data.model !== "string" || !isObject(data.answers)
      || Object.entries(body.questions).some(([id, question]) => !Object.hasOwn(data.answers, id) || data.answers[id]?.type !== question.type)) {
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid System One response from JevAPI");
    }
    return { success: true, usage: data.usage || null, response: new Response(JSON.stringify(data), { headers }) };
  } catch {
    if (signal?.aborted) return createErrorResult(499, "Request aborted");
    if (fetchSignal?.aborted) return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, "JevAPI request timed out");
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Unable to reach JevAPI");
  }
}
