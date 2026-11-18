// Content-free SSE stream diagnostics.
//
// An HTTP 200 stream that ends without a protocol terminal (the "empty stream"
// outcome) can only be explained by what the gateway actually received: which
// SSE event types arrived, whether their JSON parsed, and whether the body was
// even SSE. This module accumulates exactly those facts under fixed bounds.
//
// It never retains payload text. Event names are reduced to a bounded
// vocabulary, unparseable lines are reduced to a shape kind and a length, and
// everything else is a counter — so a production record can be shared without
// leaking a prompt, a completion, or a tool argument.

const MAX_EVENT_TYPES = 16;
const MAX_EVENT_NAME_LENGTH = 48;

// Anthropic Messages and OpenAI-compatible event names are a small fixed
// vocabulary; anything longer or unrecognized is bucketed instead of stored.
const SAFE_EVENT_NAME = /^[a-z][a-z0-9_.-]{0,47}$/;

/** Coarse shape of a line, never its content. */
function shapeOf(text) {
  const first = text.charCodeAt(0);
  if (first === 60) return "html"; // '<'
  if (first === 123) return "json"; // '{'
  if (first === 91) return "json-array"; // '['
  if (first === 58) return "sse-comment"; // ':'
  if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) return "text";
  if (first >= 48 && first <= 57) return "number";
  return "other";
}

function bump(map, key, limit) {
  if (map.size < limit || map.has(key)) map.set(key, (map.get(key) || 0) + 1);
  else return false;
  return true;
}

export function createStreamDiagnostics() {
  const eventTypes = new Map();
  // Body lines that are not SSE framing at all (an HTML error page, a bare
  // JSON error object, a plain-text throttle notice).
  const bodyShapes = new Map();
  // `data:` payloads that were not valid JSON.
  const unparsedShapes = new Map();
  const state = {
    upstreamChunks: 0,
    upstreamBytes: 0,
    lines: 0,
    eventLines: 0,
    dataLines: 0,
    otherLines: 0,
    ndjsonLines: 0,
    parsedEvents: 0,
    parseFailures: 0,
    emptyDataLines: 0,
    doneSentinelSeen: false,
    firstEventType: null,
    lastEventType: null,
    firstParsedType: null,
    lastParsedType: null,
    maxUnparsedLineLength: 0,
    maxBodyLineLength: 0,
    overflowedTypes: false,
  };

  const noteEventType = (name) => {
    if (!name) return;
    state.eventLines += 1;
    const safe = SAFE_EVENT_NAME.test(name) ? name : "other";
    state.lastEventType = safe;
    if (state.firstEventType === null) state.firstEventType = safe;
    if (!bump(eventTypes, safe, MAX_EVENT_TYPES)) state.overflowedTypes = true;
  };

  return {
    /** Raw byte/chunk counters, fed by the transform as bytes arrive. */
    noteChunk(byteLength) {
      state.upstreamChunks += 1;
      if (Number.isFinite(byteLength) && byteLength > 0) state.upstreamBytes += byteLength;
    },
    noteEventType,
    /** A `data:` payload that failed to parse. Only shape + length are kept. */
    noteUnparsed(text) {
      state.parseFailures += 1;
      const payload = String(text || "");
      state.maxUnparsedLineLength = Math.max(state.maxUnparsedLineLength, payload.length);
      bump(unparsedShapes, shapeOf(payload), MAX_EVENT_TYPES);
    },
    noteParsedType(type) {
      if (typeof type !== "string" || !type) return;
      const safe = SAFE_EVENT_NAME.test(type) && type.length <= MAX_EVENT_NAME_LENGTH ? type : "other";
      state.lastParsedType = safe;
      if (state.firstParsedType === null) state.firstParsedType = safe;
    },
    /** Classify one buffered SSE line. Content is never stored. */
    noteLine(line) {
      state.lines += 1;
      if (line.startsWith("event:")) {
        noteEventType(line.slice(6).trim());
        return;
      }
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        state.dataLines += 1;
        if (data === "[DONE]") state.doneSentinelSeen = true;
        else if (!data) state.emptyDataLines += 1;
        return;
      }
      if (line.startsWith(":")) return; // SSE comment / heartbeat
      // Not SSE framing at all: record the shape of the body we were given.
      // A JSON line here is an NDJSON upstream (Ollama) speaking its native
      // protocol, not a malformed SSE body, so it is counted separately.
      state.otherLines += 1;
      const shape = shapeOf(line);
      if (shape === "json" || shape === "json-array") {
        state.ndjsonLines += 1;
        return;
      }
      state.maxBodyLineLength = Math.max(state.maxBodyLineLength, line.length);
      bump(bodyShapes, shape, MAX_EVENT_TYPES);
    },
    noteParsedEvent() { state.parsedEvents += 1; },
    /** Fixed-shape, content-free snapshot for telemetry and logs. */
    snapshot() {
      return {
        upstreamChunks: state.upstreamChunks,
        upstreamBytes: state.upstreamBytes,
        lines: state.lines,
        eventLines: state.eventLines,
        dataLines: state.dataLines,
        otherLines: state.otherLines,
        ndjsonLines: state.ndjsonLines,
        parsedEvents: state.parsedEvents,
        parseFailures: state.parseFailures,
        emptyDataLines: state.emptyDataLines,
        doneSentinelSeen: state.doneSentinelSeen,
        firstEventType: state.firstEventType,
        lastEventType: state.lastEventType,
        firstParsedType: state.firstParsedType,
        lastParsedType: state.lastParsedType,
        maxUnparsedLineLength: state.maxUnparsedLineLength || null,
        maxBodyLineLength: state.maxBodyLineLength || null,
        eventTypes: Object.fromEntries(eventTypes),
        bodyShapes: Object.fromEntries(bodyShapes),
        unparsedShapes: Object.fromEntries(unparsedShapes),
        overflowedTypes: state.overflowedTypes,
      };
    },
  };
}

/**
 * Summarize an already-buffered upstream SSE body the same way the streaming
 * transform does. Used by the forced-streaming → JSON path, where the raw body
 * is read once into a string and never reaches the stream transform.
 */
export function summarizeSSEBody(text) {
  const diagnostics = createStreamDiagnostics();
  const body = String(text || "");
  diagnostics.noteChunk(new TextEncoder().encode(body).byteLength);
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) diagnostics.noteLine(trimmed);
  }
  // Count only payload frames the JSON parser accepts; the caller decides what
  // an unparseable frame means.
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      diagnostics.noteParsedEvent();
      diagnostics.noteParsedType(parsed?.type);
    } catch {
      diagnostics.noteUnparsed(trimmed);
    }
  }
  return diagnostics.snapshot();
}

function pairs(object, limit = 6) {
  const entries = Object.entries(object || {});
  if (!entries.length) return "none";
  const shown = entries.slice(0, limit).map(([key, count]) => `${key}=${count}`).join(",");
  return entries.length > limit ? `${shown},…` : shown;
}

/**
 * One-line, content-free rendering for the production log. Kept short enough to
 * survive a log aggregator and specific enough to separate the known shapes:
 * metadata-only upstream, unparseable body, and truncated mid-stream.
 */
export function formatStreamDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return "none";
  const parts = [
    `bytes=${diagnostics.upstreamBytes ?? 0}`,
    `chunks=${diagnostics.upstreamChunks ?? 0}`,
    `lines=${diagnostics.lines ?? 0}`,
    `parsed=${diagnostics.parsedEvents ?? 0}`,
    `parse_failures=${diagnostics.parseFailures ?? 0}`,
    `events=[${pairs(diagnostics.eventTypes)}]`,
    `first=${diagnostics.firstEventType || "-"}`,
    `last=${diagnostics.lastEventType || "-"}`,
  ];
  if (diagnostics.otherLines) parts.push(`body=[${pairs(diagnostics.bodyShapes)}]`);
  if (diagnostics.ndjsonLines) parts.push(`ndjson=${diagnostics.ndjsonLines}`);
  if (diagnostics.parseFailures) parts.push(`unparsed_shapes=[${pairs(diagnostics.unparsedShapes)}]`);
  if (diagnostics.doneSentinelSeen) parts.push("done_sentinel=1");
  if (diagnostics.maxUnparsedLineLength) parts.push(`max_unparsed_line=${diagnostics.maxUnparsedLineLength}`);
  return parts.join(" ");
}
