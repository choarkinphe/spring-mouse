// Auto routing wires three things together that unit tests alone cannot prove:
// the combo node metadata surviving capability filtering, the classifier call
// going through the normal single-model path, and the reordered list reaching
// the fallback executor unchanged. This drives the REAL chat.js handler with
// only the upstream call and the combo executor stubbed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-auto-"));
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
  getSettings: vi.fn(),
  getProviderCredentials: vi.fn(),
  attempts: [],
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
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/providers/capabilities.js", () => ({
  // Every probe node is treated as fully capable so the multimodal case exercises
  // body preservation rather than the (separate, unchanged) capability gate.
  getCapabilitiesForModel: () => ({ vision: true, pdf: true, audioInput: true, videoInput: true, tools: true }),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/services/combo.js", async (orig) => {
  const actual = await orig();
  return { ...actual, handleComboChat: mocks.handleComboChat, handleFusionChat: vi.fn() };
});
vi.mock("@/lib/modelCapabilityOverrides", () => ({
  refreshModelCapabilityOverrides: vi.fn(async () => {}),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const NODES = [
  { model: "probe/fast", autoTier: "fast", schedule: null, accessTags: [] },
  { model: "probe/balanced", autoTier: "balanced", schedule: null, accessTags: [] },
  { model: "probe/strong", autoTier: "strong", schedule: null, accessTags: [] },
];

function request(body) {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer router-key" },
    body: JSON.stringify(body),
  });
}

function classifierReply(level, confidence) {
  return {
    success: true,
    response: new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ level, confidence }) } }] }), { status: 200 }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attempts.length = 0;
  mocks.getComboModelEntries.mockResolvedValue(NODES);
  mocks.getComboByName.mockResolvedValue({ name: "route", accessTags: [], capabilities: { vision: true } });
  mocks.getModelInfo.mockImplementation(async (modelStr) => {
    const slash = modelStr.indexOf("/");
    return { provider: "probe", model: slash > 0 ? modelStr.slice(slash + 1) : modelStr };
  });
  mocks.getSettings.mockResolvedValue({
    comboStrategies: {
      route: { fallbackStrategy: "auto", autoRouting: { classifierModel: "probe/classifier" } },
    },
  });
  mocks.getProviderCredentials.mockResolvedValue({
    connectionId: "conn-1", connectionName: "one", releaseRouteSlot: () => {},
  });
  mocks.handleComboChat.mockImplementation(async ({ models }) => {
    mocks.attempts.push(models);
    return new Response("ok", { status: 200 });
  });
});

describe("auto combo routing", () => {
  it("routes a complex task to the strong tier first", async () => {
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => {
      if (modelInfo.model === "classifier") return classifierReply("complex", 0.95);
      return { success: true, response: new Response("ok", { status: 200 }) };
    });

    const res = await handleChat(request({
      model: "route",
      messages: [{ role: "user", content: "refactor the whole auth system" }],
    }));

    expect(res.status).toBe(200);
    expect(mocks.attempts.at(-1)).toEqual(["probe/strong", "probe/balanced", "probe/fast"]);
  });

  it("keeps the original request body and tool fields for the chosen model", async () => {
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => {
      if (modelInfo.model === "classifier") return classifierReply("simple", 0.99);
      return { success: true, response: new Response("ok", { status: 200 }) };
    });

    const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }] },
    ];

    const res = await handleChat(request({ model: "route", stream: true, tools, tool_choice: "auto", messages }));

    expect(res.status).toBe(200);
    const { body } = mocks.handleComboChat.mock.calls.at(-1)[0];
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual(messages);
    // Classifier output must never replace the request body it classified.
    expect(body.messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]));
  });

  it("falls back to the default tier when the classifier fails", async () => {
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => {
      if (modelInfo.model === "classifier") {
        return { success: false, status: 503, error: "overloaded", response: new Response("nope", { status: 503 }) };
      }
      return { success: true, response: new Response("ok", { status: 200 }) };
    });

    const res = await handleChat(request({ model: "route", messages: [{ role: "user", content: "hi" }] }));

    expect(res.status).toBe(200);
    // defaultLevel=standard → balanced tier leads, and no node is dropped.
    expect(mocks.attempts.at(-1)).toEqual(["probe/balanced", "probe/strong", "probe/fast"]);
  });
});
