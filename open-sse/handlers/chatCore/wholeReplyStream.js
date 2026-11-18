// Turn a whole JSON reply into the SSE stream its own protocol would have sent.
//
// A provider can answer `stream: true` with one complete JSON body instead of a
// stream. Read as a stream, such a reply yields no event at all: the client gets
// an HTTP 200 whose body ends without a protocol terminal, and a turn that
// actually succeeded is recorded (and shown) as an empty response.
//
// Magpie (`internal/gateway/whole_stream.go`) solves this the same way: it
// detects the reply from the body's first bytes rather than its Content-Type,
// expands the reply into the events its protocol streams, and hands that to the
// normal relay. Doing the same here keeps every downstream translator, usage
// extractor and terminal classifier working unchanged — the synthesized stream
// is indistinguishable from a real one.
//
// Nothing here re-frames a reply that is already a stream, and nothing invents
// content: every block, part and call goes out as the provider wrote it.

import { FORMATS } from "../../translator/formats.js";

// A whole reply larger than this is not something we will hold to re-frame.
const MAX_WHOLE_REPLY_BYTES = 8 << 20;

const SSE_START_PREFIXES = ["event:", "data:", ":"];

/** Does this body begin as server-sent events? */
export function bodyStartsAsSSE(text) {
  const head = String(text || "").replace(/^[\s﻿]+/, "");
  return SSE_START_PREFIXES.some((prefix) => head.startsWith(prefix));
}

// Hold only a possible whole object. Keep original bytes for passthrough: a
// transport chunk can end halfway through a UTF-8 character. Inspect the first
// JSON line even when it crosses chunks; ordinary NDJSON must not wait for EOF.
function wholeReplyDetector(upstreamFormat) {
  const chunks = [];
  const decoder = new TextDecoder();
  let bytes = 0, started = false, firstLine = [], expectOnlyWhitespace = false;
  return {
    chunks,
    hold(chunk) {
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes > MAX_WHOLE_REPLY_BYTES) return false;
      let part = decoder.decode(chunk, { stream: true });
      if (!started) {
        part = part.trimStart();
        if (!part) return true;
        if (!part.startsWith("{")) return false;
        started = true;
      }
      if (expectOnlyWhitespace) return !part.trim();
      if (!firstLine) return true; // pretty-printed JSON: parse the whole body at EOF
      const nl = part.indexOf("\n");
      firstLine.push(nl < 0 ? part : part.slice(0, nl));
      if (nl < 0) return true;
      let obj;
      try { obj = JSON.parse(firstLine.join("")); } catch { /* incomplete first line */ }
      firstLine = null;
      if (!obj) return true;
      // One complete Message followed by a newline is still a whole reply.
      // A stream event, or a second object, is not. Never invent its terminal.
      if (!isWholeCandidate(obj, upstreamFormat) || part.slice(nl + 1).trim()) return false;
      expectOnlyWhitespace = true;
      return true;
    },
    finish() {
      if (!started) return null;
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      let obj;
      try { obj = JSON.parse(new TextDecoder().decode(buffer).trim()); } catch { return null; }
      return wholeReplyToSSE(obj, upstreamFormat);
    },
  };
}

function isWholeCandidate(obj, format) {
  return obj?.error || (format === FORMATS.CLAUDE && obj?.type === "message" && Array.isArray(obj.content))
    || (format === FORMATS.OPENAI && Array.isArray(obj?.choices) && obj.choices.length && obj.choices.every(c => asBlock(c?.message)));
}

function drainPrefix(chunks, controller) {
  for (const chunk of chunks) controller.enqueue(chunk);
  chunks.length = 0;
}

// On a declared Claude SSE response inspect inside the streaming pipeline, not
// before returning headers. A slow first chunk is then subject to the normal
// relay's idle timer and cancellation. Real SSE passes through immediately.
function detectInStream(format) {
  let detector = wholeReplyDetector(format);
  return new TransformStream({
    transform(chunk, controller) {
      if (!detector) { controller.enqueue(chunk); return; }
      if (!detector.hold(chunk)) {
        drainPrefix(detector.chunks, controller);
        detector = null;
      }
    },
    flush(controller) {
      if (!detector) return;
      const sse = detector.finish();
      if (sse) controller.enqueue(new TextEncoder().encode(sse));
      else drainPrefix(detector.chunks, controller);
    },
  });
}

function responseWithBody(original, body, asSSE = false) {
  const headers = new Headers(original.headers);
  if (asSSE) {
    headers.set("content-type", "text/event-stream");
    headers.delete("content-length");
    headers.delete("content-encoding");
  }
  const response = new Response(body, { status: original.status, statusText: original.statusText, headers });
  carryOver(original, response);
  return response;
}

export async function wholeReplyAsStream(response, format, { streamingClient = false } = {}) {
  if (!response?.body?.getReader) return null;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const declaredSSE = type.includes("text/event-stream");
  if (declaredSSE && format !== FORMATS.CLAUDE) return null;
  if (declaredSSE || (streamingClient && format === FORMATS.CLAUDE && (type.includes("application/json") || !type))) {
    return responseWithBody(response, response.body.pipeThrough(detectInStream(format)), true);
  }
  if (type && !type.includes("json") && !type.startsWith("text/plain")) return null;

  // A forced-streaming provider with a non-streaming client needs the actual
  // content type to pick its decoder. Probe before choosing the headers here.
  const reader = response.body.getReader();
  const detector = wholeReplyDetector(format);
  let done = false, failure;
  try {
    while (true) {
      const step = await reader.read();
      done = step.done;
      if (done || !detector.hold(step.value)) break;
    }
  } catch (error) { failure = error; }
  if (done || failure) reader.releaseLock();
  const sse = done && detector.finish();
  if (sse) return responseWithBody(response, sse, true);
  return responseWithBody(response, new ReadableStream({
    start(controller) {
      drainPrefix(detector.chunks, controller);
      if (done) controller.close();
    },
    async pull(controller) {
      if (failure) { controller.error(failure); return; }
      try {
        const step = await reader.read();
        if (step.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(step.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { if (!done && !failure) return reader.cancel(reason); },
  }));
}

// Carriers the executors attach to a Response (the stream-error accessor and the
// upstream-error payload) must survive any rebuild, or a failure recorded while
// producing the body becomes invisible to the caller.
function carryOver(from, to) {
  if (from.__smGetStreamError) to.__smGetStreamError = from.__smGetStreamError;
  if (from.__smUpstreamError) to.__smUpstreamError = from.__smUpstreamError;
}

function frame(event, data) {
  const line = `data: ${JSON.stringify(data)}\n\n`;
  return event ? `event: ${event}\n${line}` : line;
}

const asBlock = (block) => (block && typeof block === "object" && !Array.isArray(block) ? { ...block } : null);

/**
 * An Anthropic `message` as the Messages stream that provokes it.
 *
 * Mirrors Magpie's `anthropicWholeEvents`: message_start carries the reply with
 * an empty content list, every block is announced, delivered and stopped in
 * order, and message_delta carries the stop details and final usage.
 */
export function claudeWholeReplyToSSE(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.type !== "message" || !Array.isArray(message.content)) return null;

  const events = [];
  const start = { ...message, content: [], stop_reason: null, stop_sequence: null };
  delete start.safeguard_results;
  if (message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)) {
    // The output is counted as it is said, in message_delta.
    start.usage = { ...message.usage, output_tokens: 0 };
  }
  events.push(frame("message_start", { type: "message_start", message: start }));

  message.content.forEach((rawBlock, index) => {
    const block = asBlock(rawBlock);
    if (!block) return;
    const delta = (payload) => events.push(frame("content_block_delta", { type: "content_block_delta", index, delta: payload }));

    switch (block.type) {
      case "text": {
        const citations = Array.isArray(block.citations) ? block.citations : [];
        const empty = { ...block, text: "" };
        if ("citations" in block) empty.citations = [];
        events.push(frame("content_block_start", { type: "content_block_start", index, content_block: empty }));
        for (const citation of citations) delta({ type: "citations_delta", citation });
        delta({ type: "text_delta", text: typeof block.text === "string" ? block.text : "" });
        break;
      }
      case "thinking": {
        events.push(frame("content_block_start", {
          type: "content_block_start", index,
          content_block: { ...block, thinking: "", signature: "" },
        }));
        delta({ type: "thinking_delta", thinking: typeof block.thinking === "string" ? block.thinking : "" });
        if (typeof block.signature === "string" && block.signature) {
          delta({ type: "signature_delta", signature: block.signature });
        }
        break;
      }
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const input = block.input === undefined || block.input === null ? {} : block.input;
        events.push(frame("content_block_start", {
          type: "content_block_start", index,
          content_block: { ...block, input: {} },
        }));
        delta({ type: "input_json_delta", partial_json: JSON.stringify(input) });
        break;
      }
      default:
        // Redacted thinking, a search's results, anything else: whole as it is.
        events.push(frame("content_block_start", { type: "content_block_start", index, content_block: block }));
        break;
    }
    events.push(frame("content_block_stop", { type: "content_block_stop", index }));
  });

  const stopDetails = {
    stop_reason: message.stop_reason ?? null,
    stop_sequence: message.stop_sequence ?? null,
  };
  if ("stop_details" in message) stopDetails.stop_details = message.stop_details;
  if ("container" in message) stopDetails.container = message.container;
  const end = { type: "message_delta", delta: stopDetails };
  if (start.usage) end.usage = message.usage;
  events.push(frame("message_delta", end));
  events.push(frame("message_stop", { type: "message_stop" }));
  return events.join("");
}

/**
 * An OpenAI `chat.completion` as the Chat Completions stream that provokes it.
 *
 * Each choice's message goes out as one delta, its tool calls numbered as a
 * stream numbers them, then the finish reason with usage, then `[DONE]`.
 */
export function openAIWholeReplyToSSE(completion) {
  if (!completion || typeof completion !== "object" || Array.isArray(completion)) return null;
  if (!Array.isArray(completion.choices) || completion.choices.length === 0) return null;
  if (completion.error || !completion.choices.every(choice => asBlock(choice?.message))) return null;

  const carrier = {};
  for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
    if (completion[key] !== undefined) carrier[key] = completion[key];
  }
  const chunk = (choices, usage) => {
    const payload = { ...carrier, object: "chat.completion.chunk", choices };
    if (usage !== undefined) payload.usage = usage;
    return frame(null, payload);
  };

  const events = [];
  const finishes = [];
  completion.choices.forEach((choice, i) => {
    const index = typeof choice?.index === "number" ? choice.index : i;
    const message = asBlock(choice?.message) || {};
    const delta = { ...message };
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      // A call that names no function cannot be run by any client, and a stream
      // never carries one. Kept calls are renumbered without a gap.
      const kept = delta.tool_calls.filter((call) => typeof call?.function?.name === "string");
      delta.tool_calls = kept.map((call, n) => ({ ...call, index: n }));
      if (kept.length === 0) delete delta.tool_calls;
    }
    events.push(chunk([{ index, delta, finish_reason: null }]));
    let finishReason = choice?.finish_reason ?? null;
    if (!delta.tool_calls && finishReason === "tool_calls") {
      // The finish named calls the reply does not carry.
      finishReason = "stop";
    }
    finishes.push({ index, finish_reason: finishReason });
  });

  // Every choice's finish goes out last, with usage on the final chunk: this is
  // the shape a real stream ends with, and the usage extractor reads it there.
  finishes.forEach((choice, i) => {
    const last = i === finishes.length - 1;
    events.push(chunk([{ ...choice, delta: {} }], last ? completion.usage : undefined));
  });
  events.push("data: [DONE]\n\n");
  return events.join("");
}

/** An upstream error body as the stream's error event. */
export function errorWholeReplyToSSE(json, upstreamFormat) {
  const error = json?.error && typeof json.error === "object" ? json.error : null;
  if (!error) return null;
  const message = typeof error.message === "string" && error.message ? error.message : "Upstream returned an error";
  if (upstreamFormat === FORMATS.CLAUDE) {
    return `event: error\n${frame(null, { type: "error", error: { type: error.type || "api_error", message } })}`;
  }
  if (upstreamFormat === FORMATS.OPENAI_RESPONSES || upstreamFormat === FORMATS.OPENAI_RESPONSE) {
    return frame("response.failed", {
      type: "response.failed",
      response: { status: "failed", error: { message } },
    });
  }
  return frame("error", { type: "error", error: { type: error.type || "api_error", message } });
}

/**
 * The SSE stream that stands for a whole JSON reply, in the UPSTREAM protocol's
 * own shape (so the existing translators and terminal classifier read it exactly
 * as they read a real stream), or null when the body is not such a reply.
 */
export function wholeReplyToSSE(json, upstreamFormat) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const errorStream = errorWholeReplyToSSE(json, upstreamFormat);
  if (errorStream) return errorStream;

  switch (upstreamFormat) {
    case FORMATS.CLAUDE:
      return claudeWholeReplyToSSE(json);
    case FORMATS.OPENAI:
      return openAIWholeReplyToSSE(json);
    default:
      return null;
  }
}
