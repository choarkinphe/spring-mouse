import { BaseExecutor } from "./base.js";
import { gzipSync } from "node:zlib";
import { DEVIN } from "../config/devin.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { runWithAbortDeadline } from "../utils/abortable.js";
import { buildUpstreamError } from "../utils/error.js";
import { resolveDevinModel } from "../services/devinModels.js";
import { SSE_HEADERS } from "../utils/sseConstants.js";
import { buildDevinHeaders, normalizeDevinSessionToken, wrapConnectEnvelope } from "../shared/devin/protocol.js";
import { buildDevinChatRequest } from "../shared/devin/request.js";
import { decodeProtobuf } from "../shared/devin/protobuf.js";
import { devinOpenAIChunks, devinCompletion } from "../shared/devin/response.js";
import { parseDevinQuotaReset } from "../shared/devin/rateLimit.js";

export function getDevinSessionToken(credentials = {}) {
  const data = credentials.providerSpecificData || {};
  return normalizeDevinSessionToken(credentials.apiKey || credentials.accessToken || data.sessionToken || data.session_token);
}

export class DevinExecutor extends BaseExecutor {
  constructor(config = {}) {
    super(DEVIN.provider, { baseUrl: DEVIN.baseUrl, ...config });
  }
  buildUrl(model, stream, urlIndex = 0, credentials = {}) {
    // Connection metadata must not redirect authenticated traffic to another host.
    const base = this.config.baseUrl;
    return `${base.replace(/\/$/, "")}${DEVIN.chatPath}`;
  }
  buildHeaders(credentials) {
    return buildDevinHeaders(getDevinSessionToken(credentials));
  }
  transformRequest(model, body, stream, credentials = {}) {
    const data = credentials.providerSpecificData || {};
    return buildDevinChatRequest({ model, body, sessionToken: getDevinSessionToken(credentials), deviceSeed: data.deviceSeed || data.device_seed || "" });
  }
  parseError(response, bodyText) {
    if (response.status === 429) {
      try {
        const payload = JSON.parse(bodyText);
        const message = payload.error?.message || payload.message;
        if (typeof message === "string") {
          return { status: response.status, message, resetsAtMs: parseDevinQuotaReset(message) };
        }
      } catch { /* preserve the default parser for non-JSON errors */ }
    }
    return super.parseError(response, bodyText);
  }
  async execute({ model, body, stream = true, credentials = {}, signal, proxyOptions = null, overloadDeadline = null }) {
    // Mouse's current JSON-only transport cannot carry Connect-proto requests.
    if (credentials.mouseExecution) throw new Error("Devin Connect-proto does not support Mouse transport");
    if (signal?.aborted) { const error = new Error("Devin request aborted"); error.name = "AbortError"; throw error; }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const url = this.buildUrl(model, stream, 0, credentials);
    let headers;
    let transformedBody;
    let upstream;
    let maxTokens;
    const startedAt = Date.now();
    try {
      headers = this.buildHeaders(credentials);
      const native = body?._devinNative;
      const effort = native?.output_config?.effort ?? native?.thinking?.effort ?? body.reasoning_effort ?? body.reasoning?.effort;
      const wireModel = await resolveDevinModel({ credentials, model, effort, proxyOptions, signal: controller.signal });
      transformedBody = this.transformRequest(wireModel, body, stream, credentials);
      maxTokens = body.max_completion_tokens || body.max_tokens;
      const remaining = Number.isFinite(overloadDeadline) ? overloadDeadline - Date.now() : Infinity;
      if (remaining <= 0) { const error = new Error("Devin dispatch deadline exceeded"); error.name = "TimeoutError"; throw error; }
      const compressed = transformedBody.length > DEVIN.gzipRequestThreshold;
      const framedBody = wrapConnectEnvelope(compressed ? gzipSync(transformedBody) : transformedBody, compressed ? DEVIN.flags.compressed : DEVIN.flags.data);
      if (compressed) headers["Connect-Content-Encoding"] = "gzip";
      upstream = await runWithAbortDeadline(() => proxyAwareFetch(url, {
        method: "POST", headers, body: framedBody, signal: controller.signal, redirect: "error",
      }, proxyOptions), {
        signal, timeoutMs: Math.min(this.config.timeoutMs || FETCH_CONNECT_TIMEOUT_MS, remaining),
        timeoutMessage: "Devin fetch connect timeout", onTimeout: error => controller.abort(error),
      });
    } catch (error) {
      controller.abort(error);
      cleanup();
      // Shared chatCore treats thrown executor failures as transport 502s.
      // Return a native-style validation response to preserve client HTTP 400.
      if (error.code === "invalid_request" && error.status === 400) {
        return {
          response: Response.json({ error: { message: error.message, type: "invalid_request_error", code: error.code } }, { status: 400 }),
          url, headers: {}, transformedBody: body,
        };
      }
      throw error;
    }
    // transformedBody is persisted by chatCore's target logger and diagnostics.
    // Never expose the wire buffer (metadata #3 contains the session token).
    const wireFields = decodeProtobuf(transformedBody);
    const safeBody = {
      protocol: DEVIN.contentType,
      model: wireFields.find(field => field.number === 21)?.value.toString("utf8"),
      wireBytes: transformedBody.length,
      metadata: { clientName: DEVIN.clientName, clientVersion: DEVIN.clientVersion, sessionToken: "[REDACTED]", deviceFingerprint: "[REDACTED]" },
      promptCount: wireFields.filter(field => field.number === 3).length,
      toolCount: wireFields.filter(field => field.number === 10).length,
    };
    const safeHeaders = { ...headers, Authorization: "[REDACTED]" };
    const result = { response: upstream, url, headers: safeHeaders, transformedBody: safeBody, timing: { upstreamHeadersMs: Math.max(0, Date.now() - startedAt) } };
    // Do not translate native HTTP failures, consume their body, or overwrite headers.
    if (!upstream.ok) {
      if (!upstream.body) { cleanup(); return result; }
      const reader = upstream.body.getReader();
      const original = upstream;
      const bodyStream = new ReadableStream({
        async pull(sink) {
          try {
            const { value, done } = await reader.read();
            if (done) { cleanup(); reader.releaseLock(); sink.close(); }
            else sink.enqueue(value);
          } catch (error) { cleanup(); sink.error(error); }
        },
        cancel(reason) { cleanup(); controller.abort(reason); return reader.cancel(reason); },
      });
      result.response = new Response(bodyStream, { status: original.status, statusText: original.statusText, headers: original.headers });
      return result;
    }
    const protocolFailure = error => {
      const status = error.status || 502;
      const responseHeaders = new Headers();
      // Preserve the upstream retry hint, but never copy binary encoding/length
      // headers onto the synthesized JSON error response.
      const retryAfter = upstream.headers.get("Retry-After");
      if (retryAfter) responseHeaders.set("Retry-After", retryAfter);
      const resetsAtMs = status === 429 ? parseDevinQuotaReset(error.message) : null;
      if (resetsAtMs && !retryAfter) responseHeaders.set("Retry-After", String(Math.ceil((resetsAtMs - Date.now()) / 1000)));
      return Response.json({ error: { message: error.message, type: "upstream_error", code: error.code || "devin_protocol_error" } }, { status, headers: responseHeaders });
    };
    if (!stream) {
      try {
        const completion = await devinCompletion(upstream.body, model, { signal: controller.signal, maxTokens });
        result.response = new Response(JSON.stringify(completion), { headers: { "Content-Type": "application/json" } });
        return result;
      } catch (error) {
        // Preserve protocol status for non-stream callers as well. Transport,
        // cancellation and malformed/truncated stream errors still propagate.
        if (signal?.aborted || error.name === "AbortError" || error.status !== 429) throw error;
        result.response = protocolFailure(error);
        return result;
      } finally { controller.abort(); cleanup(); }
    }
    const iterator = devinOpenAIChunks(upstream.body, model, { signal: controller.signal, maxTokens });
    let first;
    try {
      first = await runWithAbortDeadline(() => iterator.next(), {
        signal, timeoutMs: Math.min(this.config.timeoutMs || FETCH_CONNECT_TIMEOUT_MS, Number.isFinite(overloadDeadline) ? Math.max(1, overloadDeadline - Date.now()) : Infinity),
        timeoutMessage: "Devin first content timeout", onTimeout: error => controller.abort(error),
      });
      if (first.done) throw new Error("Devin returned an empty reply");
    } catch (error) {
      controller.abort(error); cleanup();
      if (signal?.aborted || error.name === "AbortError") throw error;
      result.response = protocolFailure(error);
      return result;
    }
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamError = null;
    const output = new ReadableStream({
      async pull(sink) {
        try {
          const next = first || await iterator.next();
          first = null;
          if (cancelled) return;
          if (next.done) {
            // The shared OpenAI passthrough stream flush emits [DONE]. Sending
            // one here duplicates it; the JSON aggregation path uses EOF.
            sink.close();
            controller.abort();
            cleanup();
          } else sink.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
        } catch (error) {
          cleanup();
          controller.abort(error);
          if (cancelled) return;
          if (signal?.aborted || error.name === "AbortError") { sink.error(error); return; }
          // An explicit OpenAI error event lets downstream SSE-to-JSON and streaming
          // consumers reject partial output. No success finish or [DONE] follows.
          const payload = { error: { message: error.message, type: "upstream_error", code: error.code || "devin_protocol_error", status: error.status || 502 } };
          const raw = JSON.stringify(payload);
          streamError = { status: payload.error.status, upstreamError: buildUpstreamError(upstream, raw, error.message, "sse", { status: payload.error.status, layer: "provider" }) };
          sink.enqueue(encoder.encode(`data: ${raw}\n\n`));
          sink.close();
        }
      },
      cancel(reason) {
        cancelled = true;
        cleanup();
        controller.abort(reason);
        // Abort unblocks a pending read before iterator.return is awaited.
        return iterator.return();
      },
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"]) responseHeaders.delete(name);
    for (const [name, value] of Object.entries(SSE_HEADERS)) responseHeaders.set(name, value);
    result.response = new Response(output, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    result.response.__smGetStreamError = () => streamError;
    return result;
  }
}
export default DevinExecutor;
