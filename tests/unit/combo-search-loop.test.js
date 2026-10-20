import { describe, it, expect, vi } from "vitest";
import { runComboSearchLoop, COMBO_SEARCH_FUNCTION as NAME, COMBO_SEARCH_LIMITS as LIMITS } from "../../src/sse/services/comboSearchLoop.js";

const formats = ["openai", "claude", "openai-responses"];
const json = (data) => Response.json(data);
const usage = (format, count = 1) => format === "openai" ? { prompt_tokens: count * 3, completion_tokens: count * 2, total_tokens: count * 5, completion_tokens_details: { reasoning_tokens: count } } : { input_tokens: count * 3, output_tokens: count * 2, ...(format === "openai-responses" ? { total_tokens: count * 5 } : { cache_read_input_tokens: count }) };
function call(format, name = NAME, id = "call_1", args = { query: "latest release", max_results: 3 }) {
  if (format === "openai") return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  if (format === "claude") return { id, type: "tool_use", name, input: args };
  return { id: `fc_${id}`, call_id: id, type: "function_call", name, arguments: JSON.stringify(args), status: "completed" };
}
function reply(format, calls = [], count = 1) {
  if (format === "openai") return { id: "chatcmpl_test", object: "chat.completion", model: "test", created: 1, choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_content: "native reasoning", ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: usage(format, count) };
  if (format === "claude") return { id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "thinking", thinking: "native reasoning", signature: "signed" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "answer" }, ...calls], stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null, usage: usage(format, count) };
  return { id: "resp_test", object: "response", model: "test", status: "completed", output: [{ id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "native reasoning" }], encrypted_content: "opaque" }, { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] }, ...calls], usage: usage(format, count) };
}
function body(format, extra = {}) {
  return { model: "combo", ...(format === "openai-responses" ? { input: "question" } : { messages: [{ role: "user", content: "question" }] }), ...extra };
}
function userTool(format, name = "user_action") {
  if (format === "openai") return { type: "function", function: { name, parameters: { type: "object" } } };
  return { ...(format === "claude" ? { input_schema: { type: "object" } } : { type: "function", parameters: { type: "object" } }), name };
}
function history(format, request) { return format === "openai-responses" ? request.input : request.messages; }
function events(text) {
  return text.trim().split("\n\n").filter((frame) => !frame.includes("[DONE]")).map((frame) => ({ event: frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7), data: JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6)) }));
}

for (const format of formats) describe(format, () => {
  it("injects optional search, preserves user tools and input, and never mutates the caller", async () => {
    const original = body(format, { tools: [userTool(format, "web_search")], tool_choice: format === "claude" ? { type: "tool", name: "web_search" } : format === "openai" ? { type: "function", function: { name: "web_search" } } : { type: "function", name: "web_search" }, stream: true, stream_options: { include_usage: true } });
    const snapshot = structuredClone(original);
    const runChat = vi.fn(async () => json(reply(format)));
    await runComboSearchLoop({ body: original, sourceFormat: format, runChat, runSearch: vi.fn() });
    const sent = runChat.mock.calls[0][0];
    expect(sent.tools[0]).toEqual(original.tools[0]);
    expect(sent.tools).toHaveLength(2);
    expect(JSON.stringify(sent.tools[1])).toContain(NAME);
    expect(sent.tool_choice).toEqual(original.tool_choice);
    expect(sent.stream).toBe(false);
    expect(sent.stream_options).toBeUndefined();
    expect(original).toEqual(snapshot);
  });

  it("replaces only hosted search declarations and resets required forcing after search", async () => {
    const original = body(format, { tools: [{ type: format === "claude" ? "web_search_20250305" : "web_search_preview", name: "web_search" }, userTool(format)], tool_choice: format === "claude" ? { type: "any" } : "required" });
    const runChat = vi.fn().mockResolvedValueOnce(json(reply(format, [call(format)]))).mockResolvedValueOnce(json(reply(format, [], 2)));
    const runSearch = vi.fn().mockResolvedValue({ results: [{ title: "release", url: "https://example.com", snippet: "data" }] });
    const response = await runComboSearchLoop({ body: original, sourceFormat: format, runChat, runSearch });
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output.usage).toEqual(usage(format, 3));
    expect(runSearch.mock.calls[0][0]).toEqual({ query: "latest release", maxResults: 3 });
    expect(runChat.mock.calls[0][0].tools).toHaveLength(2);
    const second = runChat.mock.calls[1][0];
    expect(second.tool_choice).toEqual(format === "claude" ? { type: "auto" } : "auto");
    const native = history(format, second);
    expect(JSON.stringify(native)).toContain("native reasoning");
    if (format === "openai") {
      expect(native[1].reasoning_content).toBe("native reasoning");
      expect(native[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    } else if (format === "claude") {
      expect(native[1].content[0]).toEqual({ type: "thinking", thinking: "native reasoning", signature: "signed" });
      expect(native[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
    } else {
      expect(native[0]).toEqual({ role: "user", content: "question" });
      expect(native[1].encrypted_content).toBe("opaque");
      expect(native.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    }
  });

  it("maps an explicit hosted choice and resets it after a gateway round", async () => {
    const hosted = format === "claude" ? { type: "web_search_20250305", name: "web_search" } : { type: "web_search" };
    const runChat = vi.fn().mockResolvedValueOnce(json(reply(format, [call(format)]))).mockResolvedValueOnce(json(reply(format)));
    const response = await runComboSearchLoop({ body: body(format, { tools: [hosted], tool_choice: format === "claude" ? { type: "tool", name: "web_search" } : { type: "web_search" } }), sourceFormat: format, runChat, runSearch: async () => ({ results: [] }) });
    expect(response.ok).toBe(true);
    expect(JSON.stringify(runChat.mock.calls[0][0].tool_choice)).toContain(NAME);
    expect(runChat.mock.calls[1][0].tool_choice).toEqual(format === "claude" ? { type: "auto" } : "auto");
  });

  it("honors none without injecting a tool", async () => {
    const runChat = vi.fn(async () => json(reply(format)));
    await runComboSearchLoop({ body: body(format, { tools: [userTool(format), { type: "web_search" }], tool_choice: format === "claude" ? { type: "none" } : "none" }), sourceFormat: format, runChat, runSearch: vi.fn() });
    expect(runChat.mock.calls[0][0].tools).toEqual([userTool(format)]);
  });

  it("rejects reserved collisions before any I/O, even with none", async () => {
    const runChat = vi.fn();
    const runSearch = vi.fn();
    const response = await runComboSearchLoop({ body: body(format, { tools: [userTool(format, NAME)], tool_choice: "none" }), sourceFormat: format, runChat, runSearch });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("reserved_tool_name");
    expect(runChat).not.toHaveBeenCalled();
    expect(runSearch).not.toHaveBeenCalled();
  });

  it("skips gateway execution in mixed turns, strips hidden calls, and needs no external fake result", async () => {
    const runChat = vi.fn(async () => json(reply(format, [call(format), call(format, "user_action", "external")] )));
    const runSearch = vi.fn(async () => ({ results: [{ snippet: "hidden search" }] }));
    const response = await runComboSearchLoop({ body: body(format, { tools: [userTool(format)] }), sourceFormat: format, runChat, runSearch });
    const result = await response.json();
    expect(runSearch).not.toHaveBeenCalled();
    expect(runChat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(NAME);
    expect(JSON.stringify(result)).not.toContain("hidden search");
    expect(JSON.stringify(result)).toContain("user_action");
    if (format === "openai") expect(result.choices[0].finish_reason).toBe("tool_calls");
    if (format === "claude") expect(result.stop_reason).toBe("tool_use");
    // Stateless continuation: caller returns only the visible external call and
    // its own result; neither hidden search results nor phantom calls reappear.
    const next = body(format);
    if (format === "openai") next.messages.push(result.choices[0].message, { role: "tool", tool_call_id: "external", content: "user result" });
    else if (format === "claude") next.messages.push({ role: "assistant", content: result.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "external", content: "user result" }] });
    else next.input = [{ role: "user", content: "question" }, ...result.output, { type: "function_call_output", call_id: "external", output: "user result" }];
    const continuation = vi.fn(async () => json(reply(format)));
    await runComboSearchLoop({ body: next, sourceFormat: format, runChat: continuation, runSearch });
    expect(JSON.stringify(history(format, continuation.mock.calls[0][0]))).not.toContain(NAME);
    expect(JSON.stringify(history(format, continuation.mock.calls[0][0]))).not.toContain("hidden search");
  });

  it("buffers final native SSE and sums usage without an extra generation", async () => {
    const runChat = vi.fn().mockResolvedValueOnce(json(reply(format, [call(format)]))).mockResolvedValueOnce(json(reply(format, [], 2)));
    const response = await runComboSearchLoop({ body: body(format, { stream: true }), sourceFormat: format, runChat, runSearch: async () => ({ results: [] }) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const parsed = events(text);
    expect(runChat).toHaveBeenCalledTimes(2);
    expect(text).not.toContain(NAME);
    expect(text).toContain("native reasoning");
    if (format === "openai") {
      expect(parsed.at(-1).data.usage).toEqual(usage(format, 3));
      expect(parsed[0].data.choices[0].delta.reasoning_content).toBe("native reasoning");
      expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    } else if (format === "claude") {
      expect(parsed[0].event).toBe("message_start");
      expect(parsed.at(-1).event).toBe("message_stop");
      expect(parsed.find((frame) => frame.event === "message_delta").data.usage).toEqual(usage(format, 3));
      expect(parsed.some((frame) => frame.data.delta?.type === "signature_delta" && frame.data.delta.signature === "signed")).toBe(true);
      const starts = parsed.filter((frame) => frame.event === "content_block_start");
      const stops = parsed.filter((frame) => frame.event === "content_block_stop");
      expect(starts.map((frame) => frame.data.index)).toEqual(stops.map((frame) => frame.data.index));
      expect(text).toContain("redacted_thinking");
    } else {
      expect(parsed.at(-1).event).toBe("response.completed");
      expect(parsed.at(-1).data.response.usage).toEqual(usage(format, 3));
      expect(parsed.at(-1).data.response.output[0].encrypted_content).toBe("opaque");
      expect(parsed.map((frame) => frame.data.sequence_number)).toEqual(parsed.map((_, index) => index));
      expect(parsed.some((frame) => frame.event === "response.output_text.delta")).toBe(true);
    }
  });

  it("emits external tools as valid SSE in mixed turns", async () => {
    const runSearch = vi.fn(async () => ({ results: [] }));
    const response = await runComboSearchLoop({ body: body(format, { stream: true }), sourceFormat: format, runChat: async () => json(reply(format, [call(format), call(format, "user_action", "external")])), runSearch });
    expect(runSearch).not.toHaveBeenCalled();
    const text = await response.text();
    expect(text).not.toContain(NAME);
    const parsed = events(text);
    if (format === "openai") {
      expect(parsed[0].data.choices[0].delta.tool_calls[0].index).toBe(0);
      expect(parsed.at(-1).data.choices[0].finish_reason).toBe("tool_calls");
    } else if (format === "claude") {
      expect(parsed.find((frame) => frame.data.content_block?.type === "tool_use").data.content_block.name).toBe("user_action");
      expect(parsed.find((frame) => frame.event === "message_delta").data.delta.stop_reason).toBe("tool_use");
    } else {
      const argumentsDone = parsed.find((frame) => frame.event === "response.function_call_arguments.done");
      expect(argumentsDone.data.arguments).toBe(JSON.stringify({ query: "latest release", max_results: 3 }));
      expect(parsed.at(-1).data.response.output.at(-1).name).toBe("user_action");
    }
  });
});

describe("bounds, failures and cancellation", () => {
  const options = (extra = {}) => ({ body: body("openai"), sourceFormat: "openai", runChat: vi.fn(async () => json(reply("openai"))), runSearch: vi.fn(), ...extra });
  it("bounds tool rounds", async () => {
    const runChat = vi.fn(async () => json(reply("openai", [call("openai")])));
    const runSearch = vi.fn(async () => ({ results: [] }));
    const response = await runComboSearchLoop(options({ runChat, runSearch }));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("search_limit_exceeded");
    expect(runSearch).toHaveBeenCalledTimes(LIMITS.rounds);
    expect(runChat).toHaveBeenCalledTimes(LIMITS.rounds + 1);
  });
  it("bounds calls before executing an oversized parallel batch", async () => {
    const runSearch = vi.fn();
    const response = await runComboSearchLoop(options({ runSearch, runChat: async () => json(reply("openai", Array.from({ length: LIMITS.calls + 1 }, (_, i) => call("openai", NAME, `c${i}`)))) }));
    expect(await response.text()).toContain("search_limit_exceeded");
    expect(runSearch).not.toHaveBeenCalled();
  });
  it("compacts huge results, caps their count, drops raw payloads, and bounds JSON UTF-8 bytes", async () => {
    const huge = '界😀\\n\\"'.repeat(LIMITS.resultsBytes);
    const runChat = vi.fn().mockResolvedValueOnce(json(reply("openai", [call("openai")]))).mockResolvedValueOnce(json(reply("openai")));
    const runSearch = vi.fn(async () => ({ provider_raw: { api_key: "SECRET" }, answer: huge, results: Array.from({ length: 20 }, () => ({ title: huge, url: `https://example.com/${huge}`, snippet: huge, content: { text: huge }, provider_raw: { key: "SECRET" }, metadata: { secret: "SECRET" } })) }));
    const response = await runComboSearchLoop(options({ runChat, runSearch, search: { maxResults: 2 } }));
    expect(response.status).toBe(200);
    const text = runChat.mock.calls[1][0].messages.at(-1).content;
    const compact = JSON.parse(text);
    expect(compact.results).toHaveLength(2);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(LIMITS.resultsBytes / LIMITS.calls);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("provider_raw");
    expect(text).not.toContain("\\ufffd");
    expect(compact.results[0].body).not.toBe("");
    expect(compact.results[0].url).toContain("https://example.com/");
  });
  it("keeps eight oversized search responses within the cumulative result budget", async () => {
    const runChat = vi.fn().mockResolvedValueOnce(json(reply("openai", Array.from({ length: LIMITS.calls }, (_, i) => call("openai", NAME, `call_${i}`))))).mockResolvedValueOnce(json(reply("openai")));
    const response = await runComboSearchLoop(options({ runChat, runSearch: async () => ({ results: [{ title: "title", snippet: "界".repeat(LIMITS.resultsBytes), body: "x".repeat(LIMITS.resultsBytes) }] }) }));
    expect(response.ok).toBe(true);
    const results = runChat.mock.calls[1][0].messages.filter((message) => message.role === "tool");
    expect(results).toHaveLength(LIMITS.calls);
    expect(results.reduce((sum, message) => sum + new TextEncoder().encode(message.content).length, 0)).toBeLessThanOrEqual(LIMITS.resultsBytes);
  });
  it("returns sanitized search failure to the model, never raw error credentials", async () => {
    const runChat = vi.fn().mockResolvedValueOnce(json(reply("openai", [call("openai")]))).mockResolvedValueOnce(json(reply("openai")));
    const response = await runComboSearchLoop(options({ runChat, runSearch: async () => { throw new Error("api_key=SECRET https://secret.example/path"); } }));
    expect(response.ok).toBe(true);
    expect(runChat.mock.calls[1][0].messages.at(-1).content).toBe('{"error":"search_unavailable"}');
    expect(JSON.stringify(runChat.mock.calls)).not.toContain("SECRET");
    expect(await response.text()).not.toContain("SECRET");
  });
  it.each([{ query: "" }, { query: "x", max_results: 100 }, { query: "x", max_results: 1.5 }, { query: "界".repeat(LIMITS.queryBytes) }])("validates arguments without running search %j", async (args) => {
    const runChat = vi.fn().mockResolvedValueOnce(json(reply("openai", [call("openai", NAME, "id", args)]))).mockResolvedValueOnce(json(reply("openai")));
    const runSearch = vi.fn();
    const response = await runComboSearchLoop(options({ runChat, runSearch }));
    expect(response.ok).toBe(true);
    expect(runSearch).not.toHaveBeenCalled();
    expect(runChat.mock.calls[1][0].messages.at(-1).content).toContain("invalid_search_arguments");
  });
  it("honors search.maxResults, caps model overreach, defaults to 5, and preserves an explicit user choice", async () => {
    const choice = { type: "function", function: { name: "user_action" } };
    const makeRunChat = () => vi.fn().mockResolvedValueOnce(json(reply("openai", [call("openai", NAME, "id", { query: "x" })]))).mockResolvedValueOnce(json(reply("openai")));
    for (const [search, expected] of [[{ mode: "gateway", provider: "p", maxResults: 7 }, 7], [{ mode: "gateway", maxResults: 2 }, 2], [undefined, 5], [{ maxResults: 100 }, 10]]) {
      const runChat = makeRunChat();
      const runSearch = vi.fn(async () => ({ results: [] }));
      await runComboSearchLoop(options({ search, body: body("openai", { tools: [userTool("openai")], tool_choice: choice }), runChat, runSearch }));
      expect(runSearch.mock.calls[0][0]).toEqual({ query: "x", maxResults: expected });
      expect(runChat.mock.calls[1][0].tool_choice).toEqual(choice);
    }
  });
  it("caps model result requests at the configured search maximum", async () => {
    const runChat = vi.fn().mockResolvedValueOnce(json(reply("openai", [call("openai", NAME, "id", { query: "x", max_results: 10 })]))).mockResolvedValueOnce(json(reply("openai")));
    const runSearch = vi.fn(async () => ({ results: [] }));
    await runComboSearchLoop(options({ search: { maxResults: 2 }, runChat, runSearch }));
    expect(runSearch.mock.calls[0][0]).toEqual({ query: "x", maxResults: 2 });
  });
  it.each(["missing", "duplicate"])("rejects %s gateway call IDs before search", async (kind) => {
    const calls = kind === "duplicate" ? [call("openai"), call("openai")] : [{ ...call("openai"), id: undefined }];
    const runSearch = vi.fn();
    const response = await runComboSearchLoop(options({ runChat: async () => json(reply("openai", calls)), runSearch }));
    expect(await response.text()).toContain("invalid_chat_tool_calls");
    expect(runSearch).not.toHaveBeenCalled();
  });
  it("handles pre-aborted signals and expired absolute deadlines before I/O", async () => {
    const controller = new AbortController(); controller.abort();
    for (const extra of [{ signal: controller.signal }, { deadlineMs: Date.now() - 1 }]) {
      const opts = options(extra);
      const response = await runComboSearchLoop(opts);
      expect([499, 504]).toContain(response.status);
      expect(opts.runChat).not.toHaveBeenCalled();
    }
  });
  it.each(["chat", "search"])("aborts while %s ignores cancellation", async (stage) => {
    const controller = new AbortController();
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let observedSignal;
    const pending = (_, { signal }) => { observedSignal = signal; entered(); return new Promise(() => {}); };
    const promise = runComboSearchLoop(options({ signal: controller.signal, runChat: stage === "chat" ? pending : async () => json(reply("openai", [call("openai")])), runSearch: pending }));
    await started;
    controller.abort("SECRET abort reason");
    const response = await promise;
    expect(response.status).toBe(499);
    expect(observedSignal.aborted).toBe(true);
    expect(await response.text()).not.toContain("SECRET");
  });
  it("deadlines terminate an uncooperative search callback", async () => {
    const response = await runComboSearchLoop(options({ deadlineMs: Date.now() + 30, runChat: async () => json(reply("openai", [call("openai")])), runSearch: () => new Promise(() => {}) }));
    expect(response.status).toBe(504);
  });
  it("preserves upstream non-ok Responses unchanged, including auth and retry metadata", async () => {
    for (const status of [400, 401, 403, 429, 503]) {
      const original = new Response(JSON.stringify({ error: { message: "safe router failure" } }), { status, headers: { "Content-Type": "application/json", "Retry-After": "17", "X-Route-Result": "fallback-exhausted" } });
      const response = await runComboSearchLoop(options({ runChat: async () => original }));
      expect(response).toBe(original);
      expect(response.status).toBe(status);
      expect(response.headers.get("Retry-After")).toBe("17");
      expect(response.headers.get("X-Route-Result")).toBe("fallback-exhausted");
      expect(await response.json()).toEqual({ error: { message: "safe router failure" } });
    }
  });
  it("passes through later-round non-ok responses rather than consuming their bodies", async () => {
    const original = new Response("router error", { status: 429, headers: { "Retry-After": "5" } });
    const runChat = vi.fn().mockResolvedValueOnce(json(reply("openai", [call("openai")]))).mockResolvedValueOnce(original);
    const response = await runComboSearchLoop(options({ runChat, runSearch: async () => ({ results: [] }) }));
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("router error");
  });
  it("does not leak thrown errors or malformed successful bodies", async () => {
    for (const runChat of [async () => { throw new Error("SECRET"); }, async () => new Response("SECRET")]) {
      const response = await runComboSearchLoop(options({ runChat }));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("SECRET");
    }
  });
  it.each([
    { type: "web_search", filters: { allowed_domains: ["example.com"] } },
    { type: "web_search_preview", user_location: { country: "US" } },
    { type: "web_search", external_web_access: false },
    { type: "web_search_20250305", name: "web_search", max_uses: 1 },
    { type: "web_search_20250305", name: "web_search", blocked_domains: ["private.test"] },
    { type: "web_search_20250305", name: "custom_search_name" },
  ])("rejects unsupported hosted declaration constraints before I/O %j", async (tool) => {
    const opts = options({ body: body("openai", { tools: [tool] }) });
    const response = await runComboSearchLoop(opts);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("hosted_search_constraints_not_supported");
    expect(opts.runChat).not.toHaveBeenCalled();
    expect(opts.runSearch).not.toHaveBeenCalled();
  });
  it("rejects constrained hosted choice even without a hosted declaration", async () => {
    const opts = options({ body: body("openai", { tool_choice: { type: "web_search", filters: { allowed_domains: ["example.com"] } } }) });
    const response = await runComboSearchLoop(opts);
    expect(response.status).toBe(400);
    expect(opts.runChat).not.toHaveBeenCalled();
  });
  it.each([undefined, [{ type: "web_search" }]])("rejects replayed Responses hosted search history with or without declaration", async (tools) => {
    const opts = options({ sourceFormat: "openai-responses", body: body("openai-responses", { tools, input: [{ role: "user", content: "question" }, { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "prior question" } }] }) });
    const response = await runComboSearchLoop(opts);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("hosted_search_history_not_supported");
    expect(opts.runChat).not.toHaveBeenCalled();
    expect(opts.runSearch).not.toHaveBeenCalled();
  });
  it("rejects unsupported source formats, multi-choice requests and hidden Responses history before I/O", async () => {
    for (const extra of [{ sourceFormat: "gemini" }, { body: body("openai", { n: 2 }) }, { sourceFormat: "openai-responses", body: body("openai-responses", { previous_response_id: "resp_hidden" }) }]) {
      const opts = options(extra);
      const response = await runComboSearchLoop(opts);
      expect(response.status).toBe(400);
      expect(opts.runChat).not.toHaveBeenCalled();
    }
  });
});
