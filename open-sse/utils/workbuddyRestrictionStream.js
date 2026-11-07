import { WORKBUDDY_RESTRICTION } from "../config/errorConfig.js";
import { OPENAI_STREAM_PREAMBLE_MAX_BYTES } from "../config/runtimeConfig.js";
import { isWorkBuddyRestriction } from "../shared/workbuddyRestriction.js";
import { buildUpstreamError } from "./error.js";

// Observe restriction frames throughout the stream, not just before the first
// text/tool output. Persist before forwarding the error, including JSON clients
// which aggregate SSE and never use the streaming completion callback.
export function observeWorkBuddyRestriction(response, provider, onRestriction) {
  if (!response.ok || !response.body || !WORKBUDDY_RESTRICTION.providers.has(provider)) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "", restricted = false, streamError = null;
  const frame = async (text) => {
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!isWorkBuddyRestriction(provider, data)) return text;
    const payload = JSON.parse(data);
    const message = payload.error?.message || payload.msg || "WorkBuddy account restricted (11140)";
    const upstreamError = buildUpstreamError(response, data, message, "sse", { layer: "provider" });
    streamError = { status: 403, upstreamError };
    if (!restricted) {
      restricted = true;
      await onRestriction?.({ status: 403, upstreamError });
    }
    return `data: ${JSON.stringify({ error: { code: WORKBUDDY_RESTRICTION.code, status: 403, type: "permission_error", message } })}\n\n`;
  };
  const transform = new TransformStream({
    async transform(chunk, controller) {
      if (restricted) return;
      pending += decoder.decode(chunk, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(pending))) {
        const end = separator.index + separator[0].length;
        const text = pending.slice(0, end);
        pending = pending.slice(end);
        controller.enqueue(encoder.encode(await frame(text)));
        if (restricted) { pending = ""; controller.terminate(); return; }
      }
      if (pending.length > OPENAI_STREAM_PREAMBLE_MAX_BYTES) throw new Error("WorkBuddy SSE frame exceeded scan limit");
    },
    async flush(controller) {
      if (restricted) return;
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(await frame(pending)));
    },
  });
  const watched = new Response(response.body.pipeThrough(transform), { status: response.status, headers: response.headers });
  watched.__smGetStreamError = () => streamError;
  return watched;
}
