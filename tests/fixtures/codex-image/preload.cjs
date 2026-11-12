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
  if (url.pathname === "/backend-api/codex/images/generations") {
    const body = JSON.parse(init?.body || "{}");
    console.log(`[codex-image-fixture] native model=${body.model} account=${headers.get("chatgpt-account-id")}`);
    if (body.model !== "gpt-image-2" || body.tools || body.stream || body.response_format) throw new Error("Invalid native image request shape");
    if (headers.get("chatgpt-account-id") !== (token === "Bearer fixture-b" ? "fixture-account-b" : "fixture-account-a")) throw new Error("Wrong native image account");
    return Promise.resolve(Response.json({ created: 123, data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=" }], output_format: "png", size: "1024x1024" }));
  }
  if (url.pathname === "/backend-api/wham/rate-limit-reset-credits") return Promise.resolve(Response.json({}));
  if (url.pathname === "/backend-api/codex/responses") {
    const body = JSON.parse(init?.body || "{}");
    const imageTool = body.tools?.find((tool) => tool.type === "namespace" && tool.name === "image_gen");
    if (imageTool) {
      const toolOutput = body.input?.some((item) => item.type === "function_call_output");
      const item = toolOutput
        ? { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic native image tool round-trip complete." }] }
        : { id: "fc_fixture", type: "function_call", namespace: "image_gen", name: "imagegen", call_id: "call_fixture", arguments: JSON.stringify({ prompt: "Synthetic mouse", transparent_background: false }) };
      if (toolOutput) {
        const output = body.input.find((item) => item.type === "function_call_output");
        const text = JSON.stringify(output.output);
        if (/error|failed|invalid/i.test(text)) throw new Error("Native image tool returned a failure to the model");
      }
      console.log(`[codex-image-fixture] native-tool exposed=true toolOutput=${!!toolOutput}`);
      const events = [
        { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      return Promise.resolve(new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }));
    }
    console.log(`[codex-image-fixture] model=${body.model} account=${headers.get("chatgpt-account-id")} tool=${body.tools?.[0]?.type}`);
    if (body.model !== baseModel) return Promise.resolve(Response.json({ error: { message: "Model not supported for selected fixture account" } }, { status: 400 }));
    if (headers.get("chatgpt-account-id") !== (token === "Bearer fixture-b" ? "fixture-account-b" : "fixture-account-a")) throw new Error("Wrong fixture account");
    return Promise.resolve(new Response('event: response.output_item.done\ndata: {"item":{"type":"image_generation_call","result":"c3ludGhldGljLWltYWdl"}}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
  }
  return Promise.reject(new Error(`Codex image fixture blocks ${url.pathname}`));
};
