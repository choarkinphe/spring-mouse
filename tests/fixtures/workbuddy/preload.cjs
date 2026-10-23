require("../claude-desktop-smoke/preload.cjs");
const guardedFetch = globalThis.fetch;
const allHosts = ["copilot.tencent.com", "www.workbuddy.ai", "www.codebuddy.ai"];
globalThis.fetch = function workbuddyFixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  let url; try { url = new URL(raw); } catch { return guardedFetch(input, init); }
  if (!allHosts.includes(url.hostname)) return guardedFetch(input, init);
  const json = data => Promise.resolve(Response.json({ code: 0, data }));
  // Auth (new WorkBuddy contract)
  if (url.pathname === "/v2/plugin/auth/state") return json({ state: `fixture-${url.searchParams.get("platform")}`, authUrl: `${url.origin}/fixture-login` });
  if (url.pathname === "/v2/plugin/auth/token") return json({ accessToken: "fixture-access-not-real", refreshToken: "fixture-refresh-not-real", expiresIn: 3600, refreshExpiresIn: 86400, domain: url.hostname, tokenType: "Bearer" });
  if (url.pathname === "/v2/plugin/login/account") return json({ uid: "fixture-user", nickname: "WorkBuddy fixture", email: "fixture@example.invalid" });
  // Legacy refresh endpoints (both old hosts) — proves migrated accounts still refresh.
  if (url.pathname === "/v2/plugin/auth/token/refresh") return json({ accessToken: "refreshed-access-not-real", refreshToken: "refreshed-refresh-not-real", expiresIn: 3600 });
  if (url.pathname === "/v3/config") return json({ agents: [{ name: "cli", models: ["fixture-model"] }], models: [{ id: "fixture-model", name: "WorkBuddy fixture model", supportsImages: true }] });
  if (url.pathname === "/v2/billing/meter/get-user-resource") return json({ Response: { Data: { Accounts: [{ PackageName: "Fixture", CapacitySize: 100, CapacityUsed: 10, CycleEndTime: Date.now() + 86400000 }] } } });
  if (url.pathname === "/v2/billing/meter/checkin-activity-status") return json({ CheckedIn: false });
  if (url.pathname === "/v2/chat/completions") return Promise.resolve(new Response(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: `fixture via ${url.hostname}` }, finish_reason: null }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  return Promise.reject(new Error(`fixture blocks ${url.pathname}`));
};
