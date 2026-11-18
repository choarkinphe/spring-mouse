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

/**
 * A provider answer that is one whole JSON reply, turned into the stream the
 * caller asked for.
 *
 * Only a reply whose Content-Type is JSON, absent, or text/plain is considered —
 * the shape Magpie calls "a reply that came whole". A body that actually begins
 * as SSE is left alone even when the header lies, because some vendors label a
 * stream as JSON; a body that is neither SSE nor JSON is also left alone, so
 * every existing path keeps its current behaviour.
 *
 * Returns the replacement Response, or null to leave the caller's response as-is.
 */
export async function wholeReplyAsStream(providerResponse, upstreamFormat) {
  if (!providerResponse || typeof providerResponse !== "object") return null;
  const contentType = (providerResponse.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) return null;
  const jsonish = contentType.includes("json") || contentType === "" || contentType.startsWith("text/plain");
  if (!jsonish) return null;
  if (!providerResponse.body || typeof providerResponse.body.getReader !== "function") return null;

  const reader = providerResponse.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  let exhausted = false;

  // Decide from the first bytes, never from the header alone. A body that does
  // not open as a JSON object (SSE, HTML, plain text) is handed straight back.
  // A single JSON line that parses on its own is NDJSON, not one whole reply —
  // it must not be held, or a long stream of small objects would be buffered.
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { exhausted = true; break; }
      chunks.push(decoder.decode(value, { stream: true }));
      size += value?.byteLength || value?.length || 0;

      const head = chunks.join("").replace(/^[\s﻿]+/, "");
      if (!head) continue;
      if (!head.startsWith("{")) {
        // SSE, HTML, plain text: not a whole JSON reply.
        return rebuildResponse(providerResponse, chunks.join(""), reader);
      }
      const firstBreak = head.indexOf("\n");
      if (firstBreak >= 0) {
        const firstLine = head.slice(0, firstBreak).trim();
        if (firstLine && firstLine !== "{") {
          try {
            JSON.parse(firstLine);
            // A complete JSON object on the first line, more to come: NDJSON.
            return rebuildResponse(providerResponse, chunks.join(""), reader);
          } catch { /* a pretty-printed reply's first line that isn't a value */ }
        }
      }
      // Enough to know it is one object: hold it to the end, within the cap.
      break;
    }
  } catch {
    // A read failure is the transport's business, not this conversion's.
    try { reader.cancel(); } catch { /* already closed */ }
    return null;
  }

  if (!exhausted) {
    try {
      while (size <= MAX_WHOLE_REPLY_BYTES) {
        const { value, done } = await reader.read();
        if (done) { exhausted = true; break; }
        chunks.push(decoder.decode(value, { stream: true }));
        size += value?.byteLength || value?.length || 0;
      }
    } catch {
      // Hand back what was read; the caller's normal handling owns the rest.
      return rebuildResponse(providerResponse, chunks.join(""), reader);
    }
  }
  if (exhausted) chunks.push(decoder.decode());

  const text = chunks.join("");
  if (exhausted) {
    const framed = reFrame(text, providerResponse, upstreamFormat);
    if (framed) return framed;
    return rebuildResponse(providerResponse, text, null);
  }
  // Past the cap it is not a reply we will hold; hand back every byte we took.
  return rebuildResponse(providerResponse, text, reader);
}

/** The re-framed Response for a whole JSON reply, or null. */
function reFrame(text, providerResponse, upstreamFormat) {
  let json;
  try {
    json = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const sse = wholeReplyToSSE(json, upstreamFormat);
  if (!sse) return null;

  const headers = new Headers(providerResponse.headers);
  headers.set("content-type", "text/event-stream");
  const response = new Response(sse, { status: providerResponse.status, statusText: providerResponse.statusText, headers });
  carryOver(providerResponse, response);
  return response;
}

/**
 * The bytes already read, followed by whatever is left of the upstream body.
 * `rest` is the original reader when the body was not read to its end.
 */
function rebuildResponse(providerResponse, text, rest) {
  const encode = (value) => new TextEncoder().encode(value);
  const body = !rest
    ? (text || "")
    : new ReadableStream({
      start(controller) {
        if (text) controller.enqueue(encode(text));
      },
      async pull(controller) {
        try {
          const { value, done } = await rest.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { try { rest.cancel(reason); } catch { /* already closed */ } },
    });
  const response = new Response(body, {
    status: providerResponse.status,
    statusText: providerResponse.statusText,
    headers: providerResponse.headers,
  });
  carryOver(providerResponse, response);
  return response;
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
  if (completion.error) return null;

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
