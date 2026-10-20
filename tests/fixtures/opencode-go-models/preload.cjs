require("../claude-desktop-smoke/preload.cjs");

// Only this public catalog is redirected; the shared guard blocks all other egress.
const guardedFetch = globalThis.fetch;
globalThis.fetch = function fixtureFetch(input, init) {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  if (url === "https://opencode.ai/inference/go/v1/models") {
    return guardedFetch(`http://127.0.0.1:${process.env.MOCK_PORT || 9057}/models`, init);
  }
  return guardedFetch(input, init);
};
