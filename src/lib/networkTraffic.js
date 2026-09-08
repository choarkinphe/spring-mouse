import { randomUUID } from "node:crypto";
import { createTrafficWriter } from "./networkTrafficWriter.js";
import { saveNetworkTraffic } from "@/lib/db/repos/trafficRepo.js";
import { getRequestSourceMeta } from "@/shared/utils/requestSource.js";

const trafficWriter = createTrafficWriter(saveNetworkTraffic);

export const TRAFFIC_REQUEST_ID_HEADER = "x-sm-traffic-request-id";

// A request can cross Next.js/Turbopack package boundaries without retaining
// the same Request prototype. Retain a header for adapters that rebuild the
// request and a WeakMap fallback when the runtime cannot re-wrap it.
const requestTrafficIds = new WeakMap();
let requestCloneFallbackWarned = false;

function normalizeByteLength(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function chunkByteLength(chunk) {
  if (!chunk) return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (typeof chunk.byteLength === "number") return chunk.byteLength;
  return Buffer.byteLength(String(chunk));
}

function getRequestBytes(request) {
  try {
    if (request.method === "GET" || request.method === "HEAD" || !request.body) return 0;
    // Do not clone and fully buffer an unknown-length body just for metrics.
    // That creates a second consumer of long prompts, increases GC pressure, and
    // can retain the resulting ArrayBuffer after the business handler is done.
    return normalizeByteLength(request.headers.get("content-length")) ?? 0;
  } catch {
    // Traffic accounting must never block the actual request.
    return 0;
  }
}

export function getTrafficRequestId(requestOrHeaders) {
  const headers = requestOrHeaders?.headers || requestOrHeaders;
  if (typeof headers?.get === "function") {
    return requestTrafficIds.get(requestOrHeaders) || headers.get(TRAFFIC_REQUEST_ID_HEADER) || null;
  }
  return headers?.[TRAFFIC_REQUEST_ID_HEADER] || headers?.[TRAFFIC_REQUEST_ID_HEADER.toLowerCase()] || null;
}

function cloneRequestWithTrafficId(request, requestId) {
  try {
    const headers = new Headers(request.headers);
    headers.set(TRAFFIC_REQUEST_ID_HEADER, requestId);
    const RequestCtor = request?.constructor;
    if (typeof RequestCtor !== "function") return request;
    // Use the incoming request's own constructor. Next.js dev can load an
    // undici Request from a different realm than the global Request, and the
    // cross-realm constructor performs a private-field brand check.
    const cloned = new RequestCtor(request, { headers });
    if (!cloned?.headers || typeof cloned.headers.get !== "function") {
      throw new TypeError("Request constructor returned an invalid clone");
    }
    return cloned;
  } catch (error) {
    // Monitoring is deliberately fail-open: handlers must still receive the
    // original request if cloning is unsupported by a runtime or adapter.
    if (!requestCloneFallbackWarned) {
      requestCloneFallbackWarned = true;
      console.warn("[Traffic] Request clone fallback", {
        constructor: request?.constructor?.name || "unknown",
        error: error?.message || String(error),
      });
    }
    return request;
  }
}

function isResponseLike(response) {
  return Boolean(
    response
    && typeof response === "object"
    && Number.isFinite(response.status)
    && response.headers
    && (!response.body || typeof response.body.getReader === "function")
  );
}

function cloneResponseWithBody(response, body) {
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  try {
    const ResponseCtor = response?.constructor;
    if (typeof ResponseCtor === "function") return new ResponseCtor(body, init);
  } catch {
    // Fall back to the runtime-global Response below.
  }
  return new Response(body, init);
}

export async function withNetworkTraffic(request, handler) {
  const requestId = randomUUID();
  const startedAtMs = Date.now();
  const timestamp = new Date(startedAtMs).toISOString();
  const endpoint = (() => {
    try {
      return new URL(request.url).pathname;
    } catch {
      return "unknown";
    }
  })();
  const requestBytes = getRequestBytes(request);
  if (request && (typeof request === "object" || typeof request === "function")) {
    requestTrafficIds.set(request, requestId);
  }

  const monitoredRequest = cloneRequestWithTrafficId(request, requestId);
  requestTrafficIds.set(monitoredRequest, requestId);

  let sourceMeta = {};
  try {
    sourceMeta = getRequestSourceMeta(monitoredRequest) || {};
  } catch (error) {
    console.warn("[Traffic] Request source metadata unavailable", error?.message || error);
  }
  let finalized = false;

  const finalize = ({ responseBytes = 0, statusCode = 0, aborted = false } = {}) => {
    if (finalized) return;
    finalized = true;
    const completedAtMs = Date.now();
    try {
      trafficWriter.enqueue({
        requestId,
        timestamp,
        completedAt: new Date(completedAtMs).toISOString(),
        method: request.method,
        endpoint,
        statusCode,
        requestBytes,
        responseBytes,
        durationMs: completedAtMs - startedAtMs,
        aborted,
        meta: sourceMeta,
      });
    } catch (error) {
      console.error("[Traffic] Failed to persist network usage:", error?.message || error);
    }
  };

  let response;
  try {
    response = await handler(monitoredRequest);
  } catch (error) {
    finalize({ statusCode: 500 });
    throw error;
  }

  if (!isResponseLike(response)) {
    finalize({ statusCode: 500 });
    return response;
  }

  if (!response.body) {
    finalize({ responseBytes: 0, statusCode: response.status });
    return response;
  }

  const reader = response.body.getReader();
  let responseBytes = 0;
  const meteredBody = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize({ responseBytes, statusCode: response.status });
          controller.close();
          return;
        }
        responseBytes += chunkByteLength(value);
        controller.enqueue(value);
      } catch (error) {
        finalize({ responseBytes, statusCode: response.status, aborted: true });
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finalize({ responseBytes, statusCode: response.status, aborted: true });
      }
    },
  });

  return cloneResponseWithBody(response, meteredBody);
}
