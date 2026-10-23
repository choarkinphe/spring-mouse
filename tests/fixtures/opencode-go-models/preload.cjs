require("../claude-desktop-smoke/preload.cjs");

// Only Go fixture endpoints are redirected; the shared guard blocks other egress.
const guardedFetch = globalThis.fetch;
globalThis.fetch = function fixtureFetch(input, init) {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  if (url === "https://opencode.ai/inference/go/v1/models") {
    return guardedFetch(`http://127.0.0.1:${process.env.MOCK_PORT || 9057}/models`, init);
  }
  if (url === "https://opencode.ai/inference/go/openai/v1/chat/completions" || url === "https://opencode.ai/zen/go/v1/chat/completions") {
    return guardedFetch(`http://127.0.0.1:${process.env.MOCK_PORT || 9057}/chat/completions`, init);
  }
  return guardedFetch(input, init);
};
