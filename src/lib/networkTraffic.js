import { randomUUID } from "node:crypto";
import { saveNetworkTraffic } from "@/lib/db/repos/trafficRepo.js";
import { getRequestSourceMeta } from "@/shared/utils/requestSource.js";

export const TRAFFIC_REQUEST_ID_HEADER = "x-sm-traffic-request-id";

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

async function getRequestBytes(request) {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return 0;
  const declared = normalizeByteLength(request.headers.get("content-length"));
  if (declared !== null) return declared;
  try {
    return (await request.clone().arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

export function getTrafficRequestId(requestOrHeaders) {
  const headers = requestOrHeaders?.headers || requestOrHeaders;
  if (typeof headers?.get === "function") return headers.get(TRAFFIC_REQUEST_ID_HEADER) || null;
  return headers?.[TRAFFIC_REQUEST_ID_HEADER] || headers?.[TRAFFIC_REQUEST_ID_HEADER.toLowerCase()] || null;
}

function cloneRequestWithTrafficId(request, requestId) {
  const headers = new Headers(request.headers);
  headers.set(TRAFFIC_REQUEST_ID_HEADER, requestId);
  return new Request(request, { headers });
}

function cloneResponseWithBody(response, body) {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function withNetworkTraffic(request, handler) {
  const requestId = randomUUID();
  const startedAtMs = Date.now();
  const timestamp = new Date(startedAtMs).toISOString();
  const endpoint = new URL(request.url).pathname;
  const requestBytes = await getRequestBytes(request);
  const monitoredRequest = cloneRequestWithTrafficId(request, requestId);
  const sourceMeta = getRequestSourceMeta(monitoredRequest);
  let finalized = false;

  const finalize = async ({ responseBytes = 0, statusCode = 0, aborted = false } = {}) => {
    if (finalized) return;
    finalized = true;
    const completedAtMs = Date.now();
    try {
      await saveNetworkTraffic({
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
    await finalize({ statusCode: 500 });
    throw error;
  }

  if (!(response instanceof Response)) {
    await finalize({ statusCode: 500 });
    return response;
  }

  if (!response.body) {
    await finalize({ responseBytes: 0, statusCode: response.status });
    return response;
  }

  const reader = response.body.getReader();
  let responseBytes = 0;
  const meteredBody = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finalize({ responseBytes, statusCode: response.status });
          controller.close();
          return;
        }
        responseBytes += chunkByteLength(value);
        controller.enqueue(value);
      } catch (error) {
        await finalize({ responseBytes, statusCode: response.status, aborted: true });
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finalize({ responseBytes, statusCode: response.status, aborted: true });
      }
    },
  });

  return cloneResponseWithBody(response, meteredBody);
}
