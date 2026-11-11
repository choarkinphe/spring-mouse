require("../claude-desktop-smoke/preload.cjs");
const guardedFetch = globalThis.fetch;
globalThis.fetch = function corecodeFixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  let url; try { url = new URL(raw); } catch { return guardedFetch(input, init); }
  if (url.hostname === "corecode.live" && url.pathname === "/v1/images/generations") {
    console.log("[corecode-fixture] returned synthetic image URL");
    return Promise.resolve(Response.json({ created: 123, data: [{ url: "https://93.184.216.34/synthetic.png" }] }));
  }
  if (url.hostname === "93.184.216.34" && url.pathname === "/synthetic.png") {
    console.log("[corecode-fixture] served synthetic image bytes");
    return Promise.resolve(new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "Content-Type": "image/png" } }));
  }
  return guardedFetch(input, init);
};
