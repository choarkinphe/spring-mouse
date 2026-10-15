// Shared SSE primitives (no imports → safe for executors + stream.js)
export const SSE_DONE = "data: [DONE]\n\n";
export const EMPTY_STREAM_ERROR = Object.freeze({
  type: "api_error",
  code: "empty_stream",
  message: "Upstream stream ended without model output or a terminal event.",
});

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive"
};

// Variant for web-cookie executors behind nginx (disable proxy buffering)
export const SSE_HEADERS_NO_BUFFER = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no"
};

// Variant for client-facing SSE responses (adds permissive CORS)
export const SSE_HEADERS_CORS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*"
};
