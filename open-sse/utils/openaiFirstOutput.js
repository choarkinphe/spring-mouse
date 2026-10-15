import { HTTP_STATUS, OPENAI_STREAM_PREAMBLE_MAX_BYTES } from "../config/runtimeConfig.js";
import { CODEBUDDY_RATE_LIMIT, SSE_ERROR_ORIGINS } from "../config/errorConfig.js";
import { runWithAbortDeadline } from "./abortable.js";
import { buildUpstreamError, errorResponse, normalizeErrorStatus } from "./error.js";
import { applyCodeBuddyRateLimit } from "../shared/codebuddyRateLimit.js";

// Inspect only the preamble. Keep its exact bytes for replay, then hand over the
// reader without a deadline. Role/usage/heartbeat frames are not model output.
export async function guardOpenAIFirstOutput(response, { deadlineMs, signal, abort } = {}) {
  if (!response.ok) return response;
  const reader = response.body?.getReader();
  const stop = () => {
    abort?.();
    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* already closed */ }
  };
  const fail = (message, origin = null, payload = null) => {
    stop();
    const quota = [CODEBUDDY_RATE_LIMIT.throttleCode, CODEBUDDY_RATE_LIMIT.quotaCode].includes(Number(payload?.code));
    const status = quota ? HTTP_STATUS.RATE_LIMITED
      : origin ? HTTP_STATUS.SERVICE_UNAVAILABLE
      : normalizeErrorStatus(payload?.error?.status || payload?.status);
    const result = payload ? Response.json(payload, { status }) : errorResponse(status, message);
    // Preserve HTTP 200 as transport evidence; the returned status is actionable.
    result.__smUpstreamError = buildUpstreamError(response, payload ? JSON.stringify(payload) : "", message, "sse", {
      origin, layer: origin ? "gateway" : "provider",
    });
    if (quota) {
      const parsed = applyCodeBuddyRateLimit({}, result, JSON.stringify(payload));
      result.__smUpstreamError.retryAfterMs = Math.max(result.__smUpstreamError.retryAfterMs || 0, parsed.retryAfterMs || 0) || null;
    }
    return result;
  };
  if (!reader) return fail("Upstream returned no stream body");
  if (deadlineMs <= Date.now()) return fail("Timed out waiting for first upstream output", SSE_ERROR_ORIGINS.FIRST_OUTPUT_TIMEOUT);
  let buffered = [], size = 0, pending = "";
  const decoder = new TextDecoder();
  const inspect = (data) => {
    if (data === "[DONE]") return fail("Upstream ended before any model output");
    let item;
    try { item = JSON.parse(data); } catch { return null; }
    if (item?.error || (Number(item?.code) > 0 && (item?.msg || item?.message))) {
      return fail(String(item.error?.message || item.msg || item.message || "Upstream stream error"), null, item);
    }
    return item?.choices?.some(choice => {
      const d = choice.delta || {};
      return (typeof d.content === "string" && d.content.length > 0)
        || (typeof d.reasoning_content === "string" && d.reasoning_content.length > 0)
        || (typeof d.reasoning === "string" && d.reasoning.length > 0)
        || d.tool_calls?.some(tool => tool?.id || tool?.function?.name || tool?.function?.arguments)
        || d.function_call?.name || d.function_call?.arguments
        || choice.finish_reason != null;
    }) ? true : null;
  };
  let ready;
  try {
    ready = await runWithAbortDeadline(async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // A gateway can return a JSON error with HTTP 200 instead of SSE.
          const error = inspect(pending.replace(/^data:\s*/, "").trim());
          return error instanceof Response ? error : fail("Upstream ended before any complete model output event");
        }
        buffered.push(value);
        size += value.byteLength;
        pending += decoder.decode(value, { stream: true });
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, separator.index);
          pending = pending.slice(separator.index + separator[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          const result = inspect(data);
          if (result) return result;
        }
        if (size >= OPENAI_STREAM_PREAMBLE_MAX_BYTES) {
          return fail("Upstream preamble exceeded the scan limit before model output", SSE_ERROR_ORIGINS.SCAN_LIMIT);
        }
      }
    }, { signal, timeoutMs: Math.max(1, deadlineMs - Date.now()), onTimeout: stop });
  } catch (error) {
    stop();
    if (signal?.aborted || error.name === "AbortError") throw error;
    return fail(error.name === "TimeoutError" ? "Timed out waiting for first upstream output" : "Upstream stream failed before model output",
      error.name === "TimeoutError" ? SSE_ERROR_ORIGINS.FIRST_OUTPUT_TIMEOUT : null);
  }
  if (ready instanceof Response) return ready;
  // No tee(): one reader, bounded preamble, backpressure for the rest of a long
  // response. Never retry after even part of a tool call has been accepted.
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index]);
        buffered[index++] = null;
        if (index === buffered.length) buffered = [];
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { stop(); controller.error(error); }
    },
    cancel() { stop(); },
  }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
}
