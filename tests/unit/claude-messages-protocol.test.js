// Standalone protocol tests for a Claude Messages client (`POST /v1/messages`)
// routed through the REAL `handleChatCore` + translator engine + REAL provider
// executors, with the network boundary mocked.
//
// What is exercised (no live credentials, no upstream):
//   client format = "claude" (Anthropic Messages) →
//     • openai/gpt-4o          → Claude→OpenAI request translation, Chat
//                                Completions executor, OpenAI SSE → Claude SSE
//     • deepseek/deepseek-chat → the registry's native Claude transport
//                                (/anthropic/v1/messages): request and response
//                                stay in Claude shape (zero translation).
//
// Only `proxyAwareFetch` (open-sse/utils/proxyFetch.js) and the usage sink
// (@/lib/usageDb.js) are mocked. Everything between the handler entry and the
// fetch — format detection, translator registration/selection, thinking + tool
// mapping, executor URL/header/model resolution, SSE transform, termination —
// is the production code path.
//
// Scope note: this suite pins the CORE protocol. It deliberately does not read
// any routing setting (e.g. a configurable claudeMessagesRoute) — the same
// request/response contract must hold whichever provider a Claude Messages
// request is pointed at.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Network boundary ─────────────────────────────────────────────────────────
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

// The usage/telemetry sink is fire-and-forget; stub it so the handler never
// touches the SQLite layer or the filesystem.
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { detectFormat } = await import("../../open-sse/services/provider.js");
const { detectFormatByEndpoint } = await import("../../open-sse/translator/formats.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the weather for a city",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

/** A Claude Messages body: system + one user text turn. */
function claudeBody(overrides = {}) {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 100,
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: false,
    ...overrides,
  };
}

/** A Claude Messages body with a completed tool round-trip. */
function toolRoundTripBody(overrides = {}) {
  return claudeBody({
    tools: [WEATHER_TOOL],
    messages: [
      { role: "user", content: [{ type: "text", text: "weather in Paris?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny, 21C" }],
      },
    ],
    ...overrides,
  });
}

/** Run one Claude Messages request through the real handler (network mocked). */
function runClaudeMessages(provider, model, body) {
  return handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
    connectionId: "conn-test",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    // NOTE: sourceFormatOverride is set the way production does it — the
    // /v1/messages route calls detectFormatByEndpoint(pathname, body) and hands
    // the result to the handler. Without this the handler falls back to
    // detectFormat(body), which returns "openai" for a Messages body with no
    // system/messages Claude markers (see the "detects the Claude format" case
    // above) — so a test that omits the override would not exercise the real
    // Claude-client path this suite is meant to pin.
    sourceFormatOverride: detectFormatByEndpoint("/v1/messages", body),
    clientRawRequest: {
      endpoint: "/v1/messages",
      body,
      headers: { accept: "application/json", "user-agent": "claude-cli/1.0.0" },
    },
  });
}

/** OpenAI Chat Completions SSE from a list of chunk objects. */
function openaiSSE(chunks) {
  const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Anthropic Messages SSE from a list of event objects. */
function claudeSSE(events) {
  const payload = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A complete OpenAI streaming turn: optional reasoning, then text. */
function openaiTextTurn({ model, text = "Hello", reasoning = null, promptTokens = 5, outputTokens = 1 }) {
  const chunks = [
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: null }] },
  ];
  if (reasoning && text) {
    chunks.push({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  } else if (text) {
    chunks[0].choices[0].delta.content = text;
  }
  chunks.push({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: outputTokens, total_tokens: promptTokens + outputTokens } });
  return openaiSSE(chunks);
}

/** A complete Anthropic streaming turn in native Claude shape. */
function claudeTextTurn({ model, text = "Hello", inputTokens = 5, outputTokens = 1 }) {
  return claudeSSE([
    { type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } },
    { type: "message_stop" },
  ]);
}

/** Case-insensitive header lookup on the options object handed to the fetch. */
function header(headers, name) {
  const found = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : undefined;
}

/** Fully drain a Response body and parse the SSE frames it contains. */
async function readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  const frames = [];
  for (const block of text.split("\n\n")) {
    const frame = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("data: ")) frame.data = line.slice(6);
    }
    if (frame.data !== undefined) frames.push(frame);
  }
  return { text, frames };
}

const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);
const sentUrl = (call = 0) => fetchMock.mock.calls[call][0];
const sentHeaders = (call = 0) => fetchMock.mock.calls[call][1].headers;

beforeEach(() => {
  fetchMock.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Claude Messages → openai/gpt-4o", () => {
  it("detects the Claude format from the Messages body", () => {
    expect(detectFormat(claudeBody())).toBe("claude");
  });

  it("translates the Claude request to OpenAI Chat Completions and dispatches it", async () => {
    fetchMock.mockResolvedValue(openaiTextTurn({ model: "gpt-4o" }));

    const res = await runClaudeMessages("openai", "gpt-4o", claudeBody({ stream: true }));

    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // URL + auth: the OpenAI Chat Completions endpoint, Bearer auth, SSE accept.
    expect(sentUrl()).toBe("https://api.openai.com/v1/chat/completions");
    expect(header(sentHeaders(), "authorization")).toBe("Bearer sk-test");
    expect(header(sentHeaders(), "accept")).toBe("text/event-stream");
    expect(header(sentHeaders(), "x-api-key")).toBeUndefined();

    // Body: upstream model id, Claude system → OpenAI system message, content
    // blocks flattened to strings, and stream + usage requested.
    const body = sentBody();
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
    ]);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("forces upstream streaming for the OpenAI provider even when the client asks for JSON", async () => {
    // The openai registry transport declares forceStream:true, so a non-streaming
    // Claude caller is served by the SSE→JSON path: the upstream call is still a
    // stream, and the client receives a single JSON body.
    fetchMock.mockResolvedValue(openaiTextTurn({ model: "gpt-4o", text: "ok" }));

    const res = await runClaudeMessages("openai", "gpt-4o", claudeBody({ stream: false }));

    expect(sentBody().stream).toBe(true);
    expect(res.response.status).toBe(200);
    expect(res.response.headers.get("content-type")).toContain("application/json");
    // A Claude Messages caller must receive a Claude Message, NOT the upstream
    // OpenAI chat.completion. This pins the SSE→JSON response conversion.
    const json = await res.response.json();
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.object).toBeUndefined();
    expect(json.choices).toBeUndefined();
    expect(json.content).toEqual([{ type: "text", text: "ok" }]);
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toEqual({ input_tokens: 5, output_tokens: 1 });
  });

  it("returns a Claude tool_use Message for a forced-streaming tool call with stream:false", async () => {
    fetchMock.mockResolvedValue(openaiSSE([
      { id: "chatcmpl-3", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_xyz", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] },
      { id: "chatcmpl-3", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, finish_reason: null }] },
      { id: "chatcmpl-3", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]));

    const res = await runClaudeMessages("openai", "gpt-4o", claudeBody({ stream: false }));

    const json = await res.response.json();
    expect(json.type).toBe("message");
    expect(json.choices).toBeUndefined();
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content).toEqual([
      { type: "tool_use", id: "call_xyz", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(json.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });

  it("maps Claude tools and a tool_use/tool_result round-trip onto OpenAI fields", async () => {
    fetchMock.mockResolvedValue(openaiTextTurn({ model: "gpt-4o", text: "21C" }));

    await runClaudeMessages("openai", "gpt-4o", toolRoundTripBody({ stream: true }));

    const body = sentBody();
    // Claude `tools[].input_schema` → OpenAI `function.parameters`.
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: WEATHER_TOOL.input_schema,
        },
      },
    ]);
    // Claude `tool_use` → assistant `tool_calls`; Claude `tool_result` →
    // a `role:"tool"` message carrying the same tool_call_id.
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) },
      },
    ]);
    const toolMsg = body.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ tool_call_id: "toolu_1", content: "sunny, 21C" });
  });

  it("maps an upstream OpenAI stream onto Claude Messages SSE and terminates it", async () => {
    fetchMock.mockResolvedValue(openaiTextTurn({ model: "gpt-4o", text: "Hello" }));

    const res = await runClaudeMessages("openai", "gpt-4o", claudeBody({ stream: true }));

    expect(res.response.headers.get("content-type")).toContain("text/event-stream");
    const { frames } = await readSSE(res.response);
    const events = frames.filter((f) => f.event).map((f) => f.event);
    const data = frames.filter((f) => f.event).map((f) => JSON.parse(f.data));

    // The canonical Anthropic message lifecycle, in order.
    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const textDeltas = data
      .filter((d) => d.type === "content_block_delta")
      .map((d) => d.delta.text)
      .join("");
    expect(textDeltas).toBe("Hello");

    // Terminating message_delta carries the translated stop reason + usage.
    const delta = data.find((d) => d.type === "message_delta");
    expect(delta.delta.stop_reason).toBe("end_turn");
    expect(delta.usage.input_tokens).toBe(5);
    expect(delta.usage.output_tokens).toBe(1);

    // The stream ends at message_stop (no trailing OpenAI [DONE] sentinel for
    // a translated Claude client).
    expect(data.at(-1).type).toBe("message_stop");
    expect(frames.some((f) => f.data === "[DONE]")).toBe(false);
  });

  it("emits a Claude tool_use block with a complete stop_reason for an upstream tool call", async () => {
    fetchMock.mockResolvedValue(openaiSSE([
      { id: "chatcmpl-2", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] },
      { id: "chatcmpl-2", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, finish_reason: null }] },
      { id: "chatcmpl-2", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]));

    const res = await runClaudeMessages("openai", "gpt-4o", claudeBody({ stream: true }));
    const { frames } = await readSSE(res.response);
    const data = frames.filter((f) => f.event).map((f) => JSON.parse(f.data));

    const blockStart = data.find((d) => d.type === "content_block_start");
    expect(blockStart.content_block).toMatchObject({
      type: "tool_use",
      id: "call_abc",
      name: "get_weather",
    });

    const partial = data
      .filter((d) => d.type === "content_block_delta" && d.delta.type === "input_json_delta")
      .map((d) => d.delta.partial_json)
      .join("");
    expect(JSON.parse(partial)).toEqual({ city: "Paris" });

    // OpenAI finish_reason "tool_calls" → Claude stop_reason "tool_use".
    expect(data.find((d) => d.type === "message_delta").delta.stop_reason).toBe("tool_use");
  });

  it("maps upstream reasoning_content onto a Claude thinking block ahead of the text block", async () => {
    fetchMock.mockResolvedValue(openaiTextTurn({ model: "gpt-4o", reasoning: "Let me think", text: "Answer" }));

    const res = await runClaudeMessages("openai", "gpt-4o", claudeBody({ stream: true }));
    const { frames } = await readSSE(res.response);
    const data = frames.filter((f) => f.event).map((f) => JSON.parse(f.data));

    const starts = data.filter((d) => d.type === "content_block_start");
    expect(starts).toHaveLength(2);
    expect(starts[0].content_block.type).toBe("thinking");
    expect(starts[1].content_block.type).toBe("text");
    // Distinct, ordered block indices.
    expect(starts[0].index).toBe(0);
    expect(starts[1].index).toBe(1);

    const thinking = data
      .filter((d) => d.delta?.type === "thinking_delta")
      .map((d) => d.delta.thinking)
      .join("");
    expect(thinking).toBe("Let me think");
  });

  it("resolves a thinking-suffixed client model to its bare upstream id + reasoning_effort", async () => {
    fetchMock.mockResolvedValue(openaiTextTurn({ model: "gpt-5.2" }));

    await runClaudeMessages("openai", "gpt-5.2(high)", claudeBody({ stream: true }));

    const body = sentBody();
    expect(body.model).toBe("gpt-5.2");
    expect(body.reasoning_effort).toBe("high");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Claude Messages → deepseek/deepseek-chat (native Claude transport)", () => {
  it("dispatches to the Anthropic endpoint with Claude auth and a Claude-shaped body", async () => {
    fetchMock.mockResolvedValue(claudeTextTurn({ model: "deepseek-chat" }));

    const res = await runClaudeMessages("deepseek", "deepseek-chat", claudeBody({ stream: true }));

    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The registry's `transports` entry matching sourceFormat "claude" wins, so
    // no translation happens — the request stays in Claude shape.
    expect(sentUrl()).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(header(sentHeaders(), "x-api-key")).toBe("sk-test");
    expect(header(sentHeaders(), "anthropic-version")).toBe("2023-06-01");
    expect(header(sentHeaders(), "authorization")).toBeUndefined();

    const body = sentBody();
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.system).toBe("You are a helpful assistant.");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("returns the upstream Claude Message unchanged for a non-streaming request", async () => {
    const upstream = {
      id: "msg_up",
      type: "message",
      role: "assistant",
      model: "deepseek-chat",
      content: [{ type: "text", text: "Hello from DeepSeek" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 4 },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const res = await runClaudeMessages("deepseek", "deepseek-chat", claudeBody({ stream: false }));

    expect(sentBody().stream).toBe(false);
    expect(res.response.status).toBe(200);
    expect(res.response.headers.get("content-type")).toContain("application/json");

    // targetFormat === sourceFormat === "claude": a valid Message passes straight
    // through (no OpenAI reshape), so a Claude client can consume it as-is.
    const json = await res.response.json();
    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
      model: "deepseek-chat",
      content: [{ type: "text", text: "Hello from DeepSeek" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 4 },
    });
    expect(json.choices).toBeUndefined();
  });

  it("keeps Claude tools and a tool_use/tool_result round-trip in Claude shape", async () => {
    fetchMock.mockResolvedValue(claudeTextTurn({ model: "deepseek-chat", text: "21C" }));

    await runClaudeMessages("deepseek", "deepseek-chat", toolRoundTripBody({ stream: true }));

    const body = sentBody();
    expect(body.tools).toEqual([
      expect.objectContaining({ name: "get_weather", input_schema: WEATHER_TOOL.input_schema }),
    ]);
    // No OpenAI `tool_calls`/`role:"tool"` conversion on the native path.
    expect(body.messages.some((m) => m.role === "tool")).toBe(false);
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant.content).toEqual([
      expect.objectContaining({ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }),
    ]);
    const toolResult = body.messages.at(-1).content.find((b) => b.type === "tool_result");
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_1", content: "sunny, 21C" });
  });

  it("passes a native Claude stream through, preserving thinking + tool_use blocks and terminating", async () => {
    fetchMock.mockResolvedValue(claudeSSE([
      { type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", model: "deepseek-chat", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "get_weather", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Rome"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]));

    const res = await runClaudeMessages("deepseek", "deepseek-chat", claudeBody({ stream: true }));
    const { frames } = await readSSE(res.response);
    const data = frames.filter((f) => f.event).map((f) => JSON.parse(f.data));
    const types = data.map((d) => d.type);

    expect(types).toContain("message_start");
    expect(types).toContain("message_stop");
    expect(data.find((d) => d.type === "content_block_start" && d.content_block.type === "thinking")).toBeTruthy();
    expect(data.find((d) => d.delta?.type === "thinking_delta").delta.thinking).toBe("hmm");

    const toolBlock = data.find((d) => d.type === "content_block_start" && d.content_block.type === "tool_use");
    expect(toolBlock.content_block).toMatchObject({ id: "toolu_9", name: "get_weather" });
    expect(data.find((d) => d.delta?.type === "input_json_delta").delta.partial_json).toBe('{"city":"Rome"}');
    expect(data.find((d) => d.type === "message_delta").delta.stop_reason).toBe("tool_use");

    // Termination: the stream ends (flush appended the OpenAI-compat sentinel
    // for the passthrough path) and never hangs.
    expect(frames.at(-1).data).toBe("[DONE]");
  });

  it("resolves a client alias to its upstream model id", async () => {
    fetchMock.mockResolvedValue(claudeTextTurn({ model: "deepseek-v4-pro" }));

    await runClaudeMessages("deepseek", "deepseek-v4-pro-max", claudeBody({ stream: true }));

    expect(sentBody().model).toBe("deepseek-v4-pro");
  });
});
