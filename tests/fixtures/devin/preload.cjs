// All upstream responses are synthetic; block anything not explicitly mocked.
require("../claude-desktop-smoke/preload.cjs");
const guardedFetch = globalThis.fetch;
const varint = value => { const out = []; do { let byte = value & 127; value >>>= 7; if (value) byte |= 128; out.push(byte); } while (value); return Buffer.from(out); };
const bytes = (number, value) => { const payload = Buffer.from(value); return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]); };
const int = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);
const model = (id, label) => bytes(1, Buffer.concat([bytes(1, label), int(5, 1), int(18, 262144), bytes(22, id), bytes(23, Buffer.concat([int(13, 128000), bytes(23, "swe-2")])), int(24, 4), bytes(30, bytes(1, "SWE-2 (fixture)"))]));
const frame = (payload, flag = 0) => { const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1); return Buffer.concat([header, payload]); };
globalThis.fetch = function devinFixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  let url; try { url = new URL(raw); } catch { return guardedFetch(input, init); }
  if (url.hostname === "server.codeium.com" && url.pathname.endsWith("/ExchangeDevinCLIPKCECode")) {
    let body; try { body = JSON.parse(init?.body || "{}"); } catch { body = {}; }
    return Promise.resolve(body.code === "fixture-code" && body.code_verifier
      ? Response.json({ sessionToken: "fixture-browser-devin-not-real" })
      : Response.json({ error: "invalid_grant" }, { status: 400 }));
  }
  if (url.hostname === "server.codeium.com" && url.pathname.endsWith("/GetUserStatus")) return Promise.resolve(Response.json({ userStatus: { name: "Devin 浏览器模拟账号", email: "browser-fixture@example.invalid", teamsTier: "TEAMS_TIER_DEVIN_PRO", planStatus: { dailyQuotaRemainingPercent: 90, dailyQuotaResetAtUnix: 1893456000, weeklyQuotaRemainingPercent: 75, weeklyQuotaResetAtUnix: 1893542400, planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA", devinInfo: { orgId: "fixture-org" } } } } }));
  if (url.hostname === "server.codeium.com" && url.pathname.endsWith("/GetCliModelConfigs")) return Promise.resolve(new Response(Buffer.concat([model("swe-2-high", "SWE-2 High (fixture)"), model("swe-2-low", "SWE-2 Low (fixture)")]), { headers: { "Content-Type": "application/proto" } }));
  if (url.hostname === "server.codeium.com" && url.pathname.endsWith("/GetChatMessage")) {
    if (init?.body && Buffer.from(init.body).includes(Buffer.from("fixture-quota-error"))) {
      const reset = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const utc = `${String(reset.getUTCHours()).padStart(2, "0")}:${String(reset.getUTCMinutes()).padStart(2, "0")}`;
      const message = `Synthetic fixture quota exhausted. Your limit will reset in 2 hours (at ${utc} UTC).`;
      return Promise.resolve(new Response(frame(Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message } })), 2), { headers: { "Content-Type": "application/connect+proto" } }));
    }
    // GetChatMessageResponse text field and terminal trailer, verified by adapter tests.
    return Promise.resolve(new Response(Buffer.concat([frame(Buffer.concat([bytes(3, "Devin fixture response"), int(5, 2), bytes(7, Buffer.concat([int(2, 12), int(3, 4), int(5, 2)]))])), frame(Buffer.from("{}"), 2)]), { headers: { "Content-Type": "application/connect+proto" } }));
  }
  return guardedFetch(input, init);
};
