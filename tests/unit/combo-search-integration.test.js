// Real chat.js + combo executor + search loop, mocked upstream/search I/O only.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-search-integration-"));
const PREVIOUS_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = PROBE_DIR;
delete global._dbAdapter;

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  try { fs.rmSync(PROBE_DIR, { recursive: true, force: true }); } catch {}
  if (PREVIOUS_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = PREVIOUS_DATA_DIR;
});

const mocks = vi.hoisted(() => ({
  handleChatCore: vi.fn(),
  handleComboChat: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModelEntries: vi.fn(),
  getComboByName: vi.fn(),
  getCombos: vi.fn(),
  getSettings: vi.fn(),
  getProviderCredentials: vi.fn(),
  runGatewaySearch: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    extractApiKey: vi.fn(() => null),
    authorizeApiKey: vi.fn(async () => null),
    resolveApiKeyAccessTags: vi.fn(async () => []),
    getProviderCredentials: mocks.getProviderCredentials,
  };
});
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModelEntries: mocks.getComboModelEntries,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getComboByName: mocks.getComboByName,
  getCombos: mocks.getCombos,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/providers/capabilities.js", () => ({
  // A deterministic negative tools node proves filtering before upstream I/O.
  getCapabilitiesForModel: (_provider, model) => ({ vision: true, pdf: true, audioInput: true, videoInput: true, tools: model !== "no-tools" }),
  getMeasuredCapabilitiesForConnection: () => ({}),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/services/combo.js", async (orig) => {
  const actual = await orig();
  return { ...actual, handleComboChat: mocks.handleComboChat };
});
vi.mock("@/lib/modelCapabilityOverrides", () => ({
  refreshModelCapabilityOverrides: vi.fn(async () => {}),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

vi.mock("../../src/sse/services/gatewaySearch.js", () => ({ runGatewaySearch: mocks.runGatewaySearch }));

const { COMBO_SEARCH_FUNCTION } = await import("../../src/sse/services/comboSearchLoop.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

const BINDING = { mode: "gateway", provider: "brave-search", maxResults: 5 };
const MESSAGES = [{ role: "user", content: "What changed today?" }];
const SEARCH_RESULTS = { results: [{ title: "Release notes", url: "https://example.test/release", snippet: "Released today" }] };

function request(body = {}, signal) {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "route", messages: MESSAGES, ...body }), signal,
  });
}

function reply(message, finish = "stop") {
  return { success: true, response: Response.json({ id: "chat-probe", object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) };
}
function searchReply() {
  return reply({ role: "assistant", content: null, tool_calls: [{ id: "search-call", type: "function", function: { name: COMBO_SEARCH_FUNCTION, arguments: JSON.stringify({ query: "release today", max_results: 8 }) } }] }, "tool_calls");
}
function setGraph(graph) {
  mocks.getCombos.mockResolvedValue(graph);
  mocks.getComboByName.mockImplementation(async (name) => graph.find((combo) => combo.name === name) || null);
  mocks.getComboModelEntries.mockImplementation(async (name) => graph.find((combo) => combo.name === name)?.models.map((model) => typeof model === "string" ? { model } : model) || null);
}
beforeEach(async () => {
  vi.clearAllMocks();
  const { handleComboChat } = await vi.importActual("open-sse/services/combo.js");
  mocks.handleComboChat.mockImplementation(handleComboChat);
  mocks.getModelInfo.mockImplementation(async (id) => ({ provider: id.includes("/") ? "probe" : null, model: id.split("/").at(-1) }));
  mocks.getSettings.mockResolvedValue({ comboStrategies: {} });
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "search-conn", connectionName: "search probe", releaseRouteSlot: () => {} });
  mocks.runGatewaySearch.mockResolvedValue(SEARCH_RESULTS);
  mocks.handleChatCore.mockImplementation(async ({ body }) => body.messages.some((message) => message.role === "tool") ? reply({ role: "assistant", content: "The release shipped today." }) : searchReply());
  setGraph([{ name: "route", models: ["probe/tools"], search: BINDING }]);
});

describe("real chat combo search integration", () => {
  it("injects the reserved tool, executes configured search, and continues with tool results", async () => {
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("The release shipped today.");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.handleChatCore.mock.calls.map(([options]) => options);
    expect(first.body.tools).toContainEqual(expect.objectContaining({ type: "function", function: expect.objectContaining({ name: COMBO_SEARCH_FUNCTION }) }));
    expect(first.body.stream).toBe(false);
    expect(first.body.messages).toEqual(MESSAGES);
    expect(mocks.runGatewaySearch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "brave-search", query: "release today", maxResults: 5, accessTags: [], signal: expect.any(AbortSignal), deadlineMs: expect.any(Number) }));
    expect(second.body.messages).toEqual([
      ...MESSAGES,
      expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
      { role: "tool", tool_call_id: "search-call", content: expect.any(String) },
    ]);
    expect(JSON.parse(second.body.messages.at(-1).content)).toMatchObject(SEARCH_RESULTS);
    expect(second.modelInfo).toEqual(first.modelInfo);
  });

  it.each([false, true])("exposes CORS on search-bound JSON/SSE through the real handler (stream=%s)", async (stream) => {
    const response = await handleChat(request({ stream }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-type")).toBe(stream ? "text/event-stream" : "application/json");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.runGatewaySearch).toHaveBeenCalledTimes(1);
  });

  it("correlates translated Responses item IDs through the real handler after search", async () => {
    mocks.handleChatCore.mockImplementation(async ({ body }) => {
      const continued = Array.isArray(body.input) && body.input.some((item) => item.type === "function_call_output");
      return { success: true, response: Response.json({ id: "resp-probe", object: "response", status: "completed", output: continued ? [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Evidence found" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "The release shipped today.", annotations: [] }] },
        { type: "function_call", call_id: "client-call", name: "client_action", arguments: "{}" },
      ] : [{ type: "function_call", call_id: "search-call", name: COMBO_SEARCH_FUNCTION, arguments: JSON.stringify({ query: "release today" }) }] }) };
    });
    const response = await handleChat(new Request("https://router.test/v1/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "route", input: "What changed today?", stream: true }) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const events = (await response.text()).trim().split("\n\n").map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
    const output = events.at(-1).response.output;
    expect(output.map((item) => item.id)).toEqual([expect.stringMatching(/^rs_/), expect.stringMatching(/^msg_/), expect.stringMatching(/^fc_/)]);
    expect(output[2].call_id).toBe("client-call");
    for (const event of events.filter((event) => event.output_index != null)) {
      expect(event.item?.id ?? event.item_id).toBe(output[event.output_index].id);
      if (event.type.startsWith("response.output_text.") || event.type.startsWith("response.content_part.")) expect(event.content_index).toBe(0);
    }
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.runGatewaySearch).toHaveBeenCalledTimes(1);
  });

  it("leaves unbound requests, tools and streaming mode unchanged", async () => {
    setGraph([{ name: "route", models: ["probe/no-tools"] }]);
    const tools = [{ type: "function", function: { name: "client_lookup", parameters: { type: "object" } } }];
    mocks.handleChatCore.mockImplementation(async () => ({ success: true, response: new Response("raw upstream body", { headers: { "Content-Type": "text/event-stream" } }) }));
    const response = await handleChat(request({ stream: true, tools, tool_choice: "auto" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("raw upstream body");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].body).toMatchObject({ stream: true, tools, tool_choice: "auto", messages: MESSAGES });
    expect(mocks.runGatewaySearch).not.toHaveBeenCalled();
  });

  it.each([true, false])("inherits binding through nested combos (top-level bound=%s)", async (topLevelBound) => {
    setGraph([
      { name: "route", models: ["middle"], ...(topLevelBound ? { search: BINDING } : {}) },
      { name: "middle", models: ["child"], ...(!topLevelBound ? { search: BINDING } : {}) },
      { name: "child", models: ["probe/tools"] },
    ]);
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("The release shipped today.");
    expect(mocks.runGatewaySearch).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.handleComboChat.mock.calls.map(([options]) => options.comboName)).toEqual(["route", "middle", "child"]);
  });

  it("excludes tools:false members before model dispatch", async () => {
    setGraph([{ name: "route", models: ["probe/no-tools", "probe/tools"], search: BINDING }]);
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(mocks.handleComboChat.mock.calls[0][0].models.map((entry) => typeof entry === "string" ? entry : entry.model)).toEqual(["probe/tools"]);
    expect(mocks.handleChatCore.mock.calls.every(([options]) => options.modelInfo.model === "tools")).toBe(true);
    expect(mocks.runGatewaySearch).toHaveBeenCalledTimes(1);
  });

  it("passes a shared cancellable signal to chat rounds, credentials and search", async () => {
    const controller = new AbortController();
    const response = await handleChat(request({}, controller.signal));
    expect(response.status).toBe(200);
    const signal = mocks.runGatewaySearch.mock.calls[0][0].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(mocks.handleChatCore.mock.calls.map(([options]) => options.clientSignal)).toEqual([signal, signal]);
    expect(mocks.getProviderCredentials.mock.calls.every((call) => call[3].signal === signal)).toBe(true);
  });

  it("propagates client abort into in-flight search and returns cancellation without continuation", async () => {
    const controller = new AbortController();
    let searchSignal;
    mocks.runGatewaySearch.mockImplementation(async ({ signal }) => {
      searchSignal = signal;
      controller.abort();
      return new Promise(() => {});
    });
    const response = await handleChat(request({}, controller.signal));
    expect(response.status).toBe(499);
    expect(searchSignal.aborted).toBe(true);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("returns explicit 400 for search-bound fusion (nested=%s)", async (nested) => {
    if (nested) setGraph([{ name: "route", models: ["child"] }, { name: "child", models: ["probe/tools"], search: BINDING }]);
    mocks.getSettings.mockResolvedValue({ comboStrategies: { [nested ? "child" : "route"]: { fallbackStrategy: "fusion" } } });
    const response = await handleChat(request());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Gateway search is not supported with fusion");
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(mocks.runGatewaySearch).not.toHaveBeenCalled();
  });
});
