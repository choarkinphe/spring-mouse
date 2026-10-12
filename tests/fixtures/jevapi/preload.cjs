require("../claude-desktop-smoke/preload.cjs");
const localFetch = globalThis.fetch;
globalThis.fetch = function jevFixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  const url = new URL(raw);
  if (url.origin === "https://api.typesafe.ai") {
    return localFetch(`http://127.0.0.1:${process.env.MOCK_PORT}${url.pathname}${url.search}`, init);
  }
  return localFetch(input, init);
};
