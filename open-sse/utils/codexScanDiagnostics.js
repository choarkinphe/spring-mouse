import { CODEX_SCAN_DIAGNOSTICS } from "../config/runtimeConfig.js";

// Only protocol labels are logged. Unknown upstream names are bucketed rather
// than copied: even an event/type field can contain user content or credentials.
const EVENTS = new Set([
  "response.created", "response.in_progress", "response.queued",
  "response.output_item.added", "response.output_item.done",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_text.delta", "response.reasoning_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.refusal.delta", "response.refusal.done",
  "response.completed", "response.done", "response.failed", "response.incomplete", "error",
]);
const RECOGNIZED_OUTPUT = new Set([
  "response.output_text.delta", "response.function_call_arguments.delta",
  "response.reasoning_summary_text.delta", "response.reasoning_text.delta",
]);

export function createCodexScanDiagnostics(startedAt = Date.now()) {
  let line = "";
  let event = "";
  let data = [];
  let frameChars = 0;
  let overflow = false;
  let previousCR = false;
  let chunks = 0;
  let bytes = 0;
  let lastChunkAt = null;
  let firstOutputAt = null;
  let firstCandidateAt = null;
  let firstCandidateType = null;
  let frames = 0;
  let malformedFrames = 0;
  let oversizedFrames = 0;
  let candidateFrames = 0;
  const eventCounts = {};
  const eventHeaderCounts = {};

  const label = (value) => typeof value === "string" && value.length <= CODEX_SCAN_DIAGNOSTICS.maxEventNameChars && EVENTS.has(value) ? value : "other";
  const hasText = (value) => typeof value === "string" && value.length > 0;
  const hasContent = (content) => Array.isArray(content) && content.some((part) =>
    hasText(part?.text) || hasText(part?.refusal));
  const finishFrame = (now) => {
    if (!event && !data.length && !overflow) { frameChars = 0; return; }
    frames++;
    if (overflow) oversizedFrames++;
    let parsed = null;
    if (!overflow && data.length) {
      const raw = data.join("\n");
      if (raw !== "[DONE]") {
        try { parsed = JSON.parse(raw); } catch { malformedFrames++; }
      }
    }
    const type = typeof parsed?.type === "string" ? parsed.type : event;
    const safeType = label(type);
    if (event) {
      const safeEvent = label(event);
      eventHeaderCounts[safeEvent] = (eventHeaderCounts[safeEvent] || 0) + 1;
    }
    if (safeType in eventCounts || Object.keys(eventCounts).length < CODEX_SCAN_DIAGNOSTICS.maxEventTypes) {
      eventCounts[safeType] = (eventCounts[safeType] || 0) + 1;
    } else eventCounts.other = (eventCounts.other || 0) + 1;
    // Inspect only top-level protocol output fields, never response.created's
    // echoed instructions/tools or arbitrary nested strings.
    const candidate = hasText(parsed?.delta) || hasText(parsed?.text)
      || hasText(parsed?.arguments) || hasText(parsed?.refusal)
      || (type === "response.output_item.done" && (hasText(parsed?.item?.arguments) || hasContent(parsed?.item?.content)))
      || (type === "response.content_part.done" && (hasText(parsed?.part?.text) || hasText(parsed?.part?.refusal)));
    if (candidate) {
      candidateFrames++;
      if (firstCandidateAt === null) { firstCandidateAt = now; firstCandidateType = safeType; }
    }
    event = ""; data = []; frameChars = 0; overflow = false;
  };
  const finishLine = (now) => {
    if (line === "") finishFrame(now);
    else if (!overflow) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    line = "";
  };

  return {
    observe(decoded, byteLength, now = Date.now()) {
      chunks++; bytes += byteLength; lastChunkAt = now;
      for (const char of decoded) {
        if (char === "\n" && previousCR) { previousCR = false; continue; }
        previousCR = char === "\r";
        if (char === "\n" || char === "\r") { finishLine(now); continue; }
        frameChars++;
        if (frameChars > CODEX_SCAN_DIAGNOSTICS.maxFrameChars) { overflow = true; line = ""; data = []; }
        if (!overflow) line += char;
        else line = "oversized"; // nonempty sentinel; no payload retained
      }
    },
    outputDetected(now = Date.now()) { if (firstOutputAt === null) firstOutputAt = now; },
    snapshot(now = Date.now()) {
      return {
        elapsedMs: Math.max(0, now - startedAt), chunks, bytes, frames,
        lastChunkAfterMs: lastChunkAt === null ? null : lastChunkAt - startedAt,
        lastChunkAgeMs: lastChunkAt === null ? null : Math.max(0, now - lastChunkAt),
        firstOutputAfterMs: firstOutputAt === null ? null : firstOutputAt - startedAt,
        firstCandidateAfterMs: firstCandidateAt === null ? null : firstCandidateAt - startedAt,
        firstCandidateType, candidateFrames, malformedFrames, oversizedFrames,
        eventCounts: { ...eventCounts }, eventHeaderCounts: { ...eventHeaderCounts },
        candidateWithoutDetection: candidateFrames > 0 && firstOutputAt === null,
        pendingFrameChars: frameChars,
        recognizedEventSeen: [...RECOGNIZED_OUTPUT].some((type) => eventCounts[type] > 0),
      };
    },
  };
}
