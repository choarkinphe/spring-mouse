import { DefaultExecutor } from "./default.js";
import { reserveFirstOutputDeadline, STREAM_FIRST_CHUNK_TIMEOUT_MS, FETCH_CONNECT_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.js";
import { SSE_ERROR_ORIGINS } from "../config/errorConfig.js";
import { buildUpstreamError, errorResponse } from "../utils/error.js";
import { guardOpenAIFirstOutput } from "../utils/openaiFirstOutput.js";

export class FirstOutputExecutor extends DefaultExecutor {
  async execute(args) {
    // Non-streaming calls must retain their JSON response path.
    if (!args.stream) return super.execute(args);
    const now = Date.now();
    const remaining = Number.isFinite(args.overloadDeadline)
      ? Math.max(0, args.overloadDeadline - now) : STREAM_FIRST_CHUNK_TIMEOUT_MS;
    const deadlineMs = Math.min(
      reserveFirstOutputDeadline(now + remaining, args.hasFallback, now), now + STREAM_FIRST_CHUNK_TIMEOUT_MS);
    const controller = new AbortController();
    const signal = args.signal ? AbortSignal.any([args.signal, controller.signal]) : controller.signal;
    let result;
    try {
      // Account rotation belongs to the router, even for direct requests. Four
      // retries of a silent account used to spend minutes uploading the same body.
      result = await super.execute({ ...args, signal, overloadDeadline: deadlineMs, retryWithinEndpoint: false });
    } catch (error) {
      if (error.name !== "TimeoutError" || args.signal?.aborted) throw error;
      // A connection timeout can be account-specific. Only an exhausted shared
      // budget should skip the remaining accounts and go to the next channel.
      controller.abort();
      const response = errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Timed out waiting for upstream response headers");
      response.__smUpstreamError = buildUpstreamError(null, "", "Timed out waiting for upstream response headers", "dispatch", {
        // A full connect timeout is evidence even if it coincides with this
        // candidate's budget. A late candidate cut short by the budget is not.
        origin: Date.now() - now >= (this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS)
          ? SSE_ERROR_ORIGINS.HEADER_TIMEOUT : SSE_ERROR_ORIGINS.FIRST_OUTPUT_TIMEOUT,
        layer: "gateway",
      });
      return { response, url: this.buildUrl(args.model, args.stream, 0, args.credentials), transformedBody: args.body,
        timing: { upstreamHeadersMs: Date.now() - now, firstOutputWaitMs: 0 } };
    }
    const headersAt = Date.now();
    result.response = await guardOpenAIFirstOutput(result.response, {
      deadlineMs, signal: args.signal, abort: () => controller.abort(),
      format: result.responseFormat || args.credentials?.runtimeTransport?.format || this.config.format,
      provider: this.provider,
    });
    result.timing = { upstreamHeadersMs: headersAt - now, firstOutputWaitMs: Date.now() - headersAt };
    return result;
  }
}
