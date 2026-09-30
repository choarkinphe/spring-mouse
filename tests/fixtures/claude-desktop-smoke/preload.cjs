// Preloaded before the Next server (NODE_OPTIONS=--require).
//
// 1. Marks the app as already bootstrapped so the host's background services
//    (cloud sync, DNS, cloudflared) do not start during a smoke run.
// 2. Blocks non-loopback global fetch calls used by the mock's transport.
//    This is a test guard, not an operating-system network sandbox.
// 3. Clears proxy env so nothing is silently routed through a real proxy.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[key];
}
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

global.__appBootstrapped = true;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const originalFetch = globalThis.fetch;

function isLocal(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

globalThis.fetch = function guardedFetch(input, init) {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  if (!isLocal(url)) {
    return Promise.reject(new Error(`[smoke] blocked non-local egress: ${url}`));
  }
  return originalFetch.call(this, input, init);
};
