import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR is resolved when src/ modules are first imported, so pin it before any
// of them load.
const PROBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-combo-admission-"));
const PREVIOUS_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = PROBE_DIR;
delete global._dbAdapter;

// vitest shares one process across test FILES, so leaving DATA_DIR pointed here
// leaks into every later file: another suite that builds its own database in
// beforeAll would silently read this directory instead. Restore on the way out.
afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  try { fs.rmSync(PROBE_DIR, { recursive: true, force: true }); } catch {}
  if (PREVIOUS_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = PREVIOUS_DATA_DIR;
});

const mocks = vi.hoisted(() => ({
  handleChatCore: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModelEntries: vi.fn(async () => null),
  getComboByName: vi.fn(async () => null),
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
  updateProviderCredentials: vi.fn(async () => {}),
  attempts: [],
}));

// Keep the REAL auth.js (getProviderCredentials, markAccountUnavailable); only
// the API-key gate is stubbed so the test key needs no registration.
vi.mock("../../src/sse/services/auth.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    extractApiKey: vi.fn(() => null),
    authorizeApiKey: vi.fn(async () => null),
    resolveApiKeyAccessTags: vi.fn(async () => []),
  };
});
vi.mock("@/lib/localDb", async (orig) => ({ ...(await orig()), getComboByName: mocks.getComboByName }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModelEntries: mocks.getComboModelEntries,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/lib/modelCapabilityOverrides", () => ({
  refreshModelCapabilityOverrides: vi.fn(async () => {}),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");

const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
const { reserveConnectionSlot, getLocalSlotStatus } = await import("../../src/lib/redis/connectionSlots.js");
const { REQUEST_OVERLOAD_BUDGET_MS } = await import("../../open-sse/config/runtimeConfig.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const providers = ["codebuddy-intl", "codebuddy-cn", "backup"];
let graph, accounts, held;
function request(model = "deepseek-flash", signal) {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
}
async function occupy(provider) {
  const lease = await reserveConnectionSlot([{ id: accounts[provider].id, limit: 1 }], { providerId: provider, providerLimit: 1 });
  held.push(lease);
  return lease;
}
beforeEach(async () => {
  vi.clearAllMocks();
  globalThis.__smProviderBreakers?.providers?.clear();
  globalThis.__smProviderBreakers?.overloads?.clear();
  graph = { "deepseek-flash": ["codebuddy-intl/flash", "codebuddy-cn/flash"] };
  accounts = {}; held = [];
  await updateSettings({ providerStrategies: Object.fromEntries(providers.map(p => [p, {
    hardConcurrencyEnabled: true, providerMaxConcurrentStreams: 1, maxConcurrentStreams: 1,
    queueTimeoutMs: 60000, fallbackStrategy: "request-round-robin",
  }])) });
  for (const provider of providers) {
    for (const c of await connectionsRepo.getProviderConnections({ provider })) await connectionsRepo.deleteProviderConnection(c.id);
    accounts[provider] = await connectionsRepo.createProviderConnection({ provider, authType: "apikey", apiKey: "synthetic-test-key", isActive: true, priority: 1 });
  }
  mocks.getComboModelEntries.mockImplementation(async name => graph[name] || null);
  mocks.getComboByName.mockImplementation(async name => graph[name] ? { name, accessTags: [] } : null);
  mocks.getModelInfo.mockImplementation(async name => {
    const [provider, model] = name.split("/");
    return model ? { provider, model } : { provider: null, model: name };
  });
  mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => ({ success: true, response: Response.json({ provider: modelInfo.provider }) }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const lease of held) await lease.release();
  expect(getLocalSlotStatus().active).toBe(0);
  expect(getLocalSlotStatus().queued).toBe(0);
});

describe("real combo routing and account admission", () => {
  it("prefers international when it has capacity", async () => {
    expect(await (await handleChat(request())).json()).toEqual({ provider: "codebuddy-intl" });
    expect(mocks.handleChatCore.mock.calls[0][0].hasFallback).toBe(true);
  });
  it("immediately falls back to CN when international is full", async () => {
    await occupy("codebuddy-intl");
    const start = Date.now();
    expect(await (await handleChat(request())).json()).toEqual({ provider: "codebuddy-cn" });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].hasFallback).toBe(false);
  });
  it("moves a first-output timeout to CN instead of retrying another international account", async () => {
    await connectionsRepo.createProviderConnection({provider: "codebuddy-intl", authType: "apikey", apiKey: "second-test-key", isActive: true, priority: 2});
    mocks.handleChatCore.mockImplementation(async ({modelInfo}) => modelInfo.provider === "codebuddy-intl"
      ? {success: false, status: 503, error: "Timed out waiting for first upstream output",
          upstreamError: {origin: "sse_first_output_timeout", source: "sse", status: 200, layer: "gateway"},
          response: Response.json({error: {message: "Timed out waiting for first upstream output"}}, {status: 503})}
      : {success: true, response: Response.json({provider: modelInfo.provider})});
    expect(await (await handleChat(request())).json()).toEqual({provider: "codebuddy-cn"});
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
  });
  it.each([429, 500, 503])("falls back to CN after international returns %s", async (status) => {
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => modelInfo.provider === "codebuddy-intl"
      ? { success: false, status, error: "upstream unavailable", response: Response.json({ error: { message: "upstream unavailable" } }, { status }) }
      : { success: true, response: Response.json({ provider: modelInfo.provider }) });
    expect(await (await handleChat(request())).json()).toEqual({ provider: "codebuddy-cn" });
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
  });
  it("inherits an outer fallback through a single-member nested combo", async () => {
    graph["deepseek-flash"] = ["international", "codebuddy-cn/flash"];
    graph.international = ["codebuddy-intl/flash"];
    await occupy("codebuddy-intl");
    expect(await (await handleChat(request())).json()).toEqual({ provider: "codebuddy-cn" });
  });
  it("skips an international model throttle instead of waiting out its backoff", async () => {
    const { recordProviderModelFailure } = await import("../../src/sse/services/providerBreaker.js");
    await recordProviderModelFailure("codebuddy-intl", "flash", { overloadThreshold: 1, overloadCooldownMs: 10000 }, { modelLevel: true });
    const start = Date.now();
    expect(await (await handleChat(request())).json()).toEqual({ provider: "codebuddy-cn" });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
  it("cancels the final fallback's queue without dispatching more models", async () => {
    await occupy("codebuddy-intl"); await occupy("codebuddy-cn");
    const controller = new AbortController();
    const pending = handleChat(request("deepseek-flash", controller.signal));
    await vi.waitFor(() => expect(getLocalSlotStatus().queued).toBe(1));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("waits at the final CN candidate and admits once its slot is released", async () => {
    await occupy("codebuddy-intl"); const cn = await occupy("codebuddy-cn");
    const pending = handleChat(request());
    await vi.waitFor(() => expect(getLocalSlotStatus().queued).toBe(1));
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    await cn.release();
    expect(await (await pending).json()).toEqual({ provider: "codebuddy-cn" });
  });
  it("keeps direct international requests queued and cancellable", async () => {
    await occupy("codebuddy-intl");
    const controller = new AbortController();
    const pending = handleChat(request("codebuddy-intl/flash", controller.signal));
    await vi.waitFor(() => expect(getLocalSlotStatus().queued).toBe(1));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("skips the production cycle and reaches the remaining healthy leaf", async () => {
    graph = {
      "deepseek-flash": ["codebuddy-intl/flash", "codebuddy-cn/flash", "glm-5.3-flash", "gpt-6-sol"],
      "glm-5.3-flash": ["unavailable/glm"],
      "gpt-6-sol": ["unavailable/gpt6", "gpt-5.6-sol"],
      "gpt-5.6-sol": ["unavailable/gptsol", "gpt-5.6-terra"],
      "gpt-5.6-terra": ["unavailable/gptterra", "gpt-5.6-luna"],
      "gpt-5.6-luna": ["deepseek-flash", "backup/luna"],
    };
    await occupy("codebuddy-intl"); await occupy("codebuddy-cn");
    expect(await (await handleChat(request())).json()).toEqual({ provider: "backup" });
    expect(mocks.getModelInfo.mock.calls.length).toBeLessThan(15);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
  it("terminates a pure cycle without dispatching", async () => {
    graph = { "deepseek-flash": ["loop"], loop: ["deepseek-flash"] };
    expect((await handleChat(request())).status).toBe(503);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("does not expand more nested combos once the shared deadline expires", async () => {
    graph = { "deepseek-flash": ["loop"], loop: ["deepseek-flash"] };
    const now = Date.now.bind(Date);
    mocks.getModelInfo.mockImplementation(async name => {
      vi.spyOn(Date, "now").mockImplementation(() => now() + REQUEST_OVERLOAD_BUDGET_MS + 1);
      return { provider: null, model: name };
    });
    expect((await handleChat(request())).status).toBe(504);
    expect(mocks.getModelInfo).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});

it("does not treat a sibling's shared combo as an ancestry cycle", async () => {
  const log = { info() {}, warn() {} };
  const branches = { root: ["shared", "shared"], shared: ["leaf/model"] };
  let calls = 0;
  const run = (body, model, context = {}) => branches[model]
    ? handleComboChat({ body, models: branches[model], comboName: model, handleSingleModel: run, log, ...context })
    : Promise.resolve(++calls === 1 ? Response.json({ error: { message: "busy" } }, { status: 503 }) : Response.json({ ok: true }));
  expect((await run({}, "root")).status).toBe(200);
  expect(calls).toBe(2);
});
