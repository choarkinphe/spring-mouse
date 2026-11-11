require("../claude-desktop-smoke/preload.cjs");
const guardedFetch = globalThis.fetch;
globalThis.fetch = function codexImageFixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  let url; try { url = new URL(raw); } catch { return guardedFetch(input, init); }
  if (url.hostname !== "chatgpt.com") return guardedFetch(input, init);
  const headers = new Headers(init?.headers);
  const token = headers.get("authorization");
  const baseModel = token === "Bearer fixture-b" ? "fixture-model-b" : "fixture-model-a";
  if (url.pathname === "/backend-api/wham/usage") return Promise.resolve(Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }));
  if (url.pathname === "/backend-api/codex/models") return Promise.resolve(Response.json({ models: [{ slug: baseModel, display_name: baseModel }, { slug: `${baseModel}-review`, display_name: "Review" }] }));
  if (url.pathname === "/backend-api/codex/responses") {
    const body = JSON.parse(init?.body || "{}");
    console.log(`[codex-image-fixture] model=${body.model} account=${headers.get("chatgpt-account-id")} tool=${body.tools?.[0]?.type}`);
    if (body.model !== baseModel) return Promise.resolve(Response.json({ error: { message: "Model not supported for selected fixture account" } }, { status: 400 }));
    if (headers.get("chatgpt-account-id") !== (token === "Bearer fixture-b" ? "fixture-account-b" : "fixture-account-a")) throw new Error("Wrong fixture account");
    return Promise.resolve(new Response('event: response.output_item.done\ndata: {"item":{"type":"image_generation_call","result":"c3ludGhldGljLWltYWdl"}}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
  }
  return Promise.reject(new Error(`Codex image fixture blocks ${url.pathname}`));
};
