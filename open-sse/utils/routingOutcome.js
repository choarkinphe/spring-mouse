// Isolated explicit protocol-terminal routing observer.
//
// This module answers ONE question for a single routed attempt: did the
// upstream stream reach a *real* protocol terminal event, or did it merely end?
// It exists so an external observer can record routing outcomes without
// coupling the routing engine to any storage or telemetry concern.
//
// Deliberately conservative:
//   - Only an explicit upstream protocol terminal counts. An HTTP 200 status,
//     the synthetic `data: [DONE]` sentinel, and a bare stream flush/EOF are
//     NEVER treated as a successful terminal.
//   - Every callback is optional and fail-open: an observer that throws (or
//     returns a rejected promise) must never affect the response, the fallback
//     decision, or billing. Errors are swallowed.
//   - No raw upstream payload is retained. Classification reduces a chunk to
//     `{ outcome, terminalReason }` and drops the rest.
//   - No module here imports storage/telemetry/db code; it is pure parsing.
//
// The observer contract (all fields optional, all callbacks optional):
//   onHeaders({ status, sourceFormat, targetFormat, streamMode, nativePassthrough })
//   onTerminal({ outcome, terminalReason, upstreamStatus, ttftMs, promptTokens,
//                completionTokens, durationMs })   // valid_terminal | incomplete
//   onFailed({ ...same payload... })               // outcome "failed"
//   onCancelled({ ...same payload... })            // outcome "cancelled"
//   onUnknown({ ...same payload... })              // outcome "unknown" (optional)
//
// Exactly ONE terminal callback fires per attempt, chosen by the resolved
// outcome. `onTerminal` covers a real protocol terminal (including a truncated
// but explicit `incomplete` finish); `onFailed` / `onCancelled` / `onUnknown`
// cover the rest. A recorded protocol terminal outranks a later transport-level
// disconnect/error, so a turn that genuinely finished is not relabelled because
// the socket closed afterwards.
//
// This observer is ATTEMPT-scoped only. It never emits a parent/request-level
// completion — the caller (chat.js) owns parent lifecycle.

import { FORMATS } from "../translator/formats.js";

// Outcomes mirror the fixed enum the routing telemetry consumer accepts; an
// out-of-enum value would be dropped there, so they are kept identical.
export const ROUTING_OUTCOMES = Object.freeze({
  VALID_TERMINAL: "valid_terminal",
  FAILED: "failed",
  CANCELLED: "cancelled",
  INCOMPLETE: "incomplete",
  UNKNOWN: "unknown",
});

export const TERMINAL_REASONS = Object.freeze({
  TERMINAL: "terminal",
  UPSTREAM_ERROR: "upstream_error",
  CLIENT_ABORT: "client_abort",
  STREAM_ERROR: "stream_error",
  INCOMPLETE: "incomplete",
  PARSE_ERROR: "parse_error",
  RESPONSE_ERROR: "response_error",
  UNKNOWN: "unknown",
});

export const STREAM_MODES = Object.freeze({
  STREAM: "stream",
  JSON: "json",
  SSE_TO_JSON: "sse_to_json",
});

const OUTCOME_VALUES = new Set(Object.values(ROUTING_OUTCOMES));
const REASON_VALUES = new Set(Object.values(TERMINAL_REASONS));

const VALID = Object.freeze({ outcome: ROUTING_OUTCOMES.VALID_TERMINAL, terminalReason: TERMINAL_REASONS.TERMINAL });
const FAILED = Object.freeze({ outcome: ROUTING_OUTCOMES.FAILED, terminalReason: TERMINAL_REASONS.UPSTREAM_ERROR });
const INCOMPLETE = Object.freeze({ outcome: ROUTING_OUTCOMES.INCOMPLETE, terminalReason: TERMINAL_REASONS.INCOMPLETE });
const CANCELLED = Object.freeze({ outcome: ROUTING_OUTCOMES.CANCELLED, terminalReason: TERMINAL_REASONS.CLIENT_ABORT });

function normalizeOutcome(value) {
  return OUTCOME_VALUES.has(value) ? value : ROUTING_OUTCOMES.UNKNOWN;
}

function normalizeReason(value) {
  return REASON_VALUES.has(value) ? value : TERMINAL_REASONS.UNKNOWN;
}

function toInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/**
 * Reduce any usage shape (OpenAI / Claude / Gemini) to the two counters the
 * observer reports. Never throws, never returns a partial object.
 */
export function normalizeRoutingTokens(usage) {
  if (!usage || typeof usage !== "object") return { promptTokens: null, completionTokens: null };
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? usage.inputTokenCount;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? usage.outputTokenCount;
  return { promptTokens: toInteger(prompt), completionTokens: toInteger(completion) };
}

// ---- per-format terminal classification -----------------------------------

function openAIFinishOutcome(finishReason) {
  if (typeof finishReason !== "string" || !finishReason) return null;
  const reason = finishReason.toLowerCase();
  if (reason === "error") return FAILED;
  // A truncated / filtered turn is NOT a valid terminal, but it is a terminal:
  // the protocol said the turn is over, it just did not finish cleanly.
  if (reason === "length" || reason === "content_filter") return INCOMPLETE;
  return VALID;
}

function geminiFinishOutcome(finishReason) {
  if (typeof finishReason !== "string" || !finishReason) return null;
  const reason = finishReason.toUpperCase();
  if (reason === "FINISH_REASON_UNSPECIFIED") return null;
  if (reason === "STOP") return VALID;
  if (reason === "MAX_TOKENS") return INCOMPLETE;
  // SAFETY / RECITATION / PROHIBITED_CONTENT / MALFORMED_FUNCTION_CALL / ...
  return FAILED;
}

function responsesStatusOutcome(status) {
  if (typeof status !== "string" || !status) return null;
  switch (status.toLowerCase()) {
    case "completed":
    case "done":
      return VALID;
    case "failed":
      return FAILED;
    case "incomplete":
      return INCOMPLETE;
    case "cancelled":
    case "canceled":
      return CANCELLED;
    default:
      return null;
  }
}

/** OpenAI Chat Completions streaming chunk. */
export function classifyOpenAIChatChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.error) return FAILED;
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null; // usage-only / metadata chunk
  return openAIFinishOutcome(choices[0]?.finish_reason);
}

/** OpenAI Responses API streaming event (event name + parsed payload). */
export function classifyResponsesEvent(eventName, chunk) {
  const type = typeof eventName === "string" && eventName
    ? eventName
    : (typeof chunk?.type === "string" ? chunk.type : null);
  switch (type) {
    case "response.completed":
    case "response.done":
      return VALID;
    case "response.failed":
      return FAILED;
    case "response.incomplete":
      return INCOMPLETE;
    case "error":
      return FAILED;
    default:
      break;
  }
  return responsesStatusOutcome(chunk?.response?.status ?? chunk?.status);
}

/** Claude Messages API streaming event. `message_stop` is the terminal. */
export function classifyClaudeEvent(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.type === "error" || chunk.error) return FAILED;
  if (chunk.type === "message_stop") return VALID;
  return null;
}

/** Gemini / Antigravity / Vertex streaming chunk. */
export function classifyGeminiEvent(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.error) return FAILED;
  if (chunk.promptFeedback?.blockReason) return FAILED;
  const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
  if (candidate?.finishReason) return geminiFinishOutcome(candidate.finishReason);
  return null;
}

/** Ollama NDJSON stream chunk. */
export function classifyOllamaEvent(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.error) return FAILED;
  if (chunk.done === true) {
    const reason = typeof chunk.done_reason === "string" ? chunk.done_reason.toLowerCase() : "";
    if (reason === "length") return INCOMPLETE;
    return VALID;
  }
  return null;
}

/**
 * Dispatch a parsed upstream stream event to the right format classifier.
 * Returns `{ outcome, terminalReason }` for a real protocol terminal, else null.
 * `targetFormat` is the UPSTREAM format (the format we spoke to the provider).
 */
export function classifyStreamEvent(targetFormat, eventName, chunk) {
  switch (targetFormat) {
    case FORMATS.OPENAI:
      return classifyOpenAIChatChunk(chunk);
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
      return classifyResponsesEvent(eventName, chunk);
    case FORMATS.CLAUDE:
      return classifyClaudeEvent(chunk);
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.ANTIGRAVITY:
    case FORMATS.VERTEX:
      return classifyGeminiEvent(chunk);
    case FORMATS.OLLAMA:
      return classifyOllamaEvent(chunk);
    default:
      // Binary / provider-specific upstreams (kiro, cursor, commandcode) decode
      // into one of the shapes above; try each so a terminal is still seen.
      return classifyOpenAIChatChunk(chunk)
        || classifyResponsesEvent(eventName, chunk)
        || classifyClaudeEvent(chunk)
        || classifyGeminiEvent(chunk)
        || classifyOllamaEvent(chunk);
  }
}

function parseSSEBlock(block) {
  let eventName = null;
  const dataLines = [];
  for (const rawLine of String(block || "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { eventName, data: dataLines.join("\n") };
}

/**
 * Classify a whole buffered upstream SSE text body (the forced-streaming →
 * JSON path, where the raw stream is read once into a string).
 *
 * A failure anywhere wins over an earlier valid terminal: a stream that
 * completed and then errored did not succeed.
 */
export function classifyRawSSEBlock(text, targetFormat) {
  const blocks = String(text || "").split(/\n\n+/);
  let terminal = null;
  let failure = null;
  for (const block of blocks) {
    const { eventName, data } = parseSSEBlock(block);
    if (!data || data === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    const classified = classifyStreamEvent(targetFormat, eventName, chunk);
    if (!classified) continue;
    if (classified.outcome === ROUTING_OUTCOMES.FAILED) failure = classified;
    terminal = classified;
  }
  return failure || terminal;
}

/**
 * Classify a non-streaming (JSON) upstream body.
 *
 * `lenient` is for the ordinary non-streaming path: the provider answered with
 * a 200 JSON body, so a shape we do not recognize is still a completed response
 * and is treated as a valid terminal. The forced-streaming → JSON path passes
 * `lenient: false` because it derives status from an explicit protocol event,
 * where an unrecognized/`in_progress` status must NOT be read as success.
 */
export function classifyJsonBody(body, targetFormat, { lenient = false } = {}) {
  const fallback = lenient
    ? VALID
    : { outcome: ROUTING_OUTCOMES.UNKNOWN, terminalReason: TERMINAL_REASONS.UNKNOWN };
  if (!body || typeof body !== "object") return fallback;
  if (body.error) return FAILED;

  switch (targetFormat) {
    case FORMATS.OPENAI: {
      if (Array.isArray(body.choices)) {
        if (body.choices.length === 0) return VALID;
        return openAIFinishOutcome(body.choices[0]?.finish_reason) || VALID;
      }
      if (body.object === "chat.completion") return VALID;
      break;
    }
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE: {
      const byStatus = responsesStatusOutcome(body.status);
      if (byStatus) return byStatus;
      // A status that is present but unrecognized (e.g. "in_progress") means the
      // response never reached a terminal state.
      if (typeof body.status === "string" && body.status) break;
      if (Array.isArray(body.output)) return VALID;
      break;
    }
    case FORMATS.CLAUDE: {
      if (body.type === "message") {
        return body.stop_reason === "max_tokens" ? INCOMPLETE : VALID;
      }
      if (Array.isArray(body.content)) return VALID;
      break;
    }
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.ANTIGRAVITY:
    case FORMATS.VERTEX: {
      if (body.promptFeedback?.blockReason) return FAILED;
      const candidate = Array.isArray(body.candidates) ? body.candidates[0] : null;
      if (candidate?.finishReason) return geminiFinishOutcome(candidate.finishReason) || INCOMPLETE;
      if (Array.isArray(body.candidates)) return VALID;
      break;
    }
    case FORMATS.OLLAMA: {
      if (body.done === true) return classifyOllamaEvent(body);
      break;
    }
    default:
      break;
  }

  return fallback;
}

/**
 * Cheap check: does this event carry model output (as opposed to pure
 * framing/metadata)? Used to timestamp TTFT at the first visible token.
 */
export function hasContentForFormat(targetFormat, chunk) {
  if (!chunk || typeof chunk !== "object") return false;
  switch (targetFormat) {
    case FORMATS.OPENAI: {
      const delta = chunk.choices?.[0]?.delta;
      return Boolean(delta && (delta.content || delta.reasoning_content
        || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)));
    }
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE: {
      const type = chunk.type;
      return typeof type === "string" && type.endsWith(".delta");
    }
    case FORMATS.CLAUDE: {
      if (chunk.type !== "content_block_delta") return false;
      const delta = chunk.delta || {};
      return Boolean(delta.text || delta.thinking || delta.partial_json);
    }
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.ANTIGRAVITY:
    case FORMATS.VERTEX: {
      const parts = chunk.candidates?.[0]?.content?.parts;
      return Array.isArray(parts) && parts.some((part) => typeof part?.text === "string" && part.text.length > 0);
    }
    case FORMATS.OLLAMA:
      return Boolean(chunk.message?.content);
    default: {
      const delta = chunk.choices?.[0]?.delta;
      return Boolean(delta && (delta.content || delta.reasoning_content));
    }
  }
}

/**
 * Wrap a caller-supplied observer into a fail-open, single-terminal emitter.
 *
 * Returns null when no observer is supplied, so every call site can simply do
 * `routing?.settle(...)` and pay nothing when the feature is off.
 *
 * @param {object}   options.observer          - { onHeaders?, onTerminal?, onFailed?, onCancelled?, onUnknown? }
 * @param {number}   options.requestStartTime  - epoch ms used to derive ttftMs / durationMs
 */
export function createRoutingObserver({ observer, requestStartTime = Date.now() } = {}) {
  if (!observer || typeof observer !== "object") return null;

  const emit = (fn, payload) => {
    try {
      if (typeof fn === "function") Promise.resolve(fn(payload)).catch(() => { /* observer is best-effort */ });
    } catch { /* an observer must never affect routing */ }
  };

  let settled = false;
  let headersEmitted = false;
  let ttftMs = null;
  let recordedTerminal = null;

  const buildPayload = (outcome, terminalReason, info) => {
    const tokens = normalizeRoutingTokens(info.usage);
    return {
      outcome,
      terminalReason,
      upstreamStatus: toInteger(info.upstreamStatus ?? info.status),
      ttftMs: toInteger(ttftMs ?? info.ttftMs),
      promptTokens: toInteger(info.promptTokens ?? tokens.promptTokens),
      completionTokens: toInteger(info.completionTokens ?? tokens.completionTokens),
      durationMs: toInteger(Date.now() - requestStartTime),
    };
  };

  // Map the resolved outcome onto its callback. A truncated-but-explicit finish
  // ("incomplete") is still a protocol terminal, so it shares onTerminal.
  const callbackFor = (outcome) => {
    switch (outcome) {
      case ROUTING_OUTCOMES.VALID_TERMINAL:
      case ROUTING_OUTCOMES.INCOMPLETE:
        return observer.onTerminal;
      case ROUTING_OUTCOMES.FAILED:
        return observer.onFailed;
      case ROUTING_OUTCOMES.CANCELLED:
        return observer.onCancelled;
      default:
        return observer.onUnknown;
    }
  };

  const settle = (info = {}) => {
    if (settled) return;
    settled = true;
    const outcome = normalizeOutcome(recordedTerminal?.outcome || info.outcome);
    const terminalReason = normalizeReason(recordedTerminal?.terminalReason || info.terminalReason);
    emit(callbackFor(outcome), buildPayload(outcome, terminalReason, info));
  };

  return {
    /** Record the first real protocol terminal seen on the upstream stream. */
    recordTerminal(info) {
      if (!recordedTerminal && info && OUTCOME_VALUES.has(info.outcome)) {
        recordedTerminal = {
          outcome: info.outcome,
          terminalReason: normalizeReason(info.terminalReason),
        };
      }
      return recordedTerminal;
    },
    hasTerminal() {
      return recordedTerminal !== null;
    },
    /** Stamp TTFT on the first event carrying model output (idempotent). */
    noteFirstToken() {
      if (ttftMs === null) ttftMs = Math.max(0, Date.now() - requestStartTime);
    },
    hasFirstToken() {
      return ttftMs !== null;
    },
    isSettled() {
      return settled;
    },
    emitHeaders(info = {}) {
      if (headersEmitted) return;
      headersEmitted = true;
      emit(observer.onHeaders, {
        status: toInteger(info.status),
        sourceFormat: info.sourceFormat ?? null,
        targetFormat: info.targetFormat ?? null,
        streamMode: info.streamMode || STREAM_MODES.JSON,
        nativePassthrough: info.nativePassthrough === true,
      });
    },
    /** Settle the attempt, preferring a recorded protocol terminal. */
    settle,
    /** Settle as an upstream/transport failure unless a terminal was recorded. */
    settleFailed(info = {}) {
      settle({ ...info, outcome: info.outcome || ROUTING_OUTCOMES.FAILED, terminalReason: info.terminalReason || TERMINAL_REASONS.STREAM_ERROR });
    },
    /** Settle as a client-initiated cancellation unless a terminal was recorded. */
    settleCancelled(info = {}) {
      settle({ ...info, outcome: info.outcome || ROUTING_OUTCOMES.CANCELLED, terminalReason: info.terminalReason || TERMINAL_REASONS.CLIENT_ABORT });
    },
  };
}
