// Claude Desktop 3P gateway compatibility — discovery → Messages, end to end.
//
// Claude Desktop populates its picker from `GET /v1/models` and lists only ids
// it recognises as Claude unless the entry carries `anthropic_family_tier`. This
// suite drives the REAL models route and the REAL messages route (with only the
// upstream network boundary mocked) against a seeded SQLite database, and pins:
//
//   discovery   GET /v1/models with `anthropic-version` returns the Models API
//               envelope carrying the configured default combo, marked with a
//               tier so Desktop accepts the opaque combo id.
//   messages    POST /v1/messages for a bare `claude-*` model resolves to the
//               same configured combo, and its exact id is what routes upstream.
//   safety      no route / disabled / empty / non-LLM / out-of-schedule /
//               access-denied targets are advertised or routed; an invalid
//               ingress key is rejected; OpenAI-format callers keep the old shape.
//
// Only `proxyAwareFetch` (the network boundary) and the usage sink are mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-claude-desktop-"));
process.env.DATA_DIR = DATA_DIR;
delete global._dbAdapter;

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

const { GET: getModels } = await import("@/app/api/v1/models/route.js");
const { POST: postMessages } = await import("@/app/api/v1/messages/route.js");
const {
  createCombo, deleteCombo, getCombos, createApiKey, updateSettings,
} = await import("@/lib/localDb");
const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");

const COMBO_ID = "deepseek-flash"; // the user's real combo id: no tier word in it

/** Reset persisted combos so each case starts from a clean picker. */
async function resetCombos() {
  for (const combo of await getCombos()) await deleteCombo(combo.id);
}

/** A seeded upstream connection for a native-Claude-transport provider. */
async function seedUpstream() {
  await createProviderConnection({
    provider: "deepseek",
    authType: "apikey",
    name: "deepseek-test",
    apiKey: "sk-upstream",
    providerSpecificData: {},
  });
}

function modelsRequest({ apiKey = null, anthropicVersion = null } = {}) {
  const headers = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  if (anthropicVersion) headers["anthropic-version"] = anthropicVersion;
  return new Request("https://router.test/v1/models", { method: "GET", headers });
}

function messagesRequest(model, { apiKey = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  return new Request("https://router.test/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: false,
    }),
  });
}

const claudeUpstreamMessage = (model) => new Response(JSON.stringify({
  id: "msg_up", type: "message", role: "assistant", model,
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
}), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(claudeUpstreamMessage("deepseek-chat"));
  await resetCombos();
  await updateSettings({ requireApiKey: false, claudeMessagesRoute: "", apiKeyAccessTags: {} });
});

describe("Claude Desktop discovery (GET /v1/models)", () => {
  it("returns the Anthropic Models API envelope for the configured default combo", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"] });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await getModels(modelsRequest({ anthropicVersion: "2023-06-01" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.has_more).toBe(false);
    const entry = body.data[0];
    expect(entry).toMatchObject({
      type: "model",
      id: COMBO_ID,
      display_name: COMBO_ID,
      anthropic_family_tier: "sonnet",
      is_family_default: true,
    });
    // A valid Models API entry carries a created_at and fabricates no capability.
    expect(typeof entry.created_at).toBe("string");
    expect(entry.max_tokens).toBeUndefined();
    expect(entry.capabilities).toBeUndefined();
  });

  it("keeps the OpenAI list shape for callers without anthropic-version", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"] });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await getModels(modelsRequest());
    const body = await res.json();

    expect(body.object).toBe("list");
    expect(body.data.some((m) => m.id === COMBO_ID)).toBe(true);
    expect(body.data.find((m) => m.id === COMBO_ID)).toMatchObject({
      object: "model", anthropic_family_tier: "sonnet", is_family_default: true,
    });
    expect(body.has_more).toBeUndefined();
  });

  it("marks only the configured combo and preserves other OpenAI entries", async () => {
    await createCombo({ name: COMBO_ID, groupName: "DeepSeek", kind: "llm", models: ["deepseek/deepseek-chat"] });
    await createCombo({ name: "other-route", kind: "llm", models: ["deepseek/deepseek-chat"] });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });
    const body = await (await getModels(modelsRequest())).json();
    expect(body.data.find(m => m.id === COMBO_ID).display_name).toBe(`${COMBO_ID} · DeepSeek`);
    expect(body.data.find(m => m.id === "other-route")).toEqual({
      id: "other-route", object: "model", owned_by: "combo", is_combo: true,
    });
  });

  it("accepts x-api-key as the ingress credential", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"] });
    const key = await createApiKey("desktop-key", "machine");
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await getModels(modelsRequest({ apiKey: key.key, anthropicVersion: "2023-06-01" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].id).toBe(COMBO_ID);
  });

  it("rejects an invalid ingress key", async () => {
    const res = await getModels(modelsRequest({ apiKey: "sk-not-a-real-key", anthropicVersion: "2023-06-01" }));
    expect(res.status).toBe(401);
  });

  it("advertises nothing when no default route is configured", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"] });

    const res = await getModels(modelsRequest({ anthropicVersion: "2023-06-01" }));
    expect((await res.json()).data).toEqual([]);
  });

  it.each([
    ["disabled", { isActive: false }],
    ["empty", { models: [] }],
    ["non-LLM", { kind: "webSearch", models: ["deepseek/deepseek-chat"] }],
  ])("does not advertise a %s default combo", async (_label, overrides) => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"], ...overrides });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await getModels(modelsRequest({ anthropicVersion: "2023-06-01" }));
    expect((await res.json()).data).toEqual([]);
  });

  it("does not advertise a combo whose members are all outside their schedule", async () => {
    await seedUpstream();
    await createCombo({
      name: COMBO_ID, kind: "llm",
      models: [{
        model: "deepseek/deepseek-chat",
        schedule: {
          timezone: "UTC", active: [], inactive: [{ start: "00:00", end: "23:59" }],
          activeEnabled: true, inactiveEnabled: true,
        },
      }],
    });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await getModels(modelsRequest({ anthropicVersion: "2023-06-01" }));
    expect((await res.json()).data).toEqual([]);
  });

  it("does not advertise a combo the ingress key is not tagged for", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"], accessTags: ["team-a"] });
    const key = await createApiKey("restricted-key", "machine");
    await updateSettings({
      claudeMessagesRoute: COMBO_ID,
      apiKeyAccessTags: { [key.id]: ["team-b"] },
    });

    const res = await getModels(modelsRequest({ apiKey: key.key, anthropicVersion: "2023-06-01" }));
    expect((await res.json()).data).toEqual([]);
  });
});

describe("Claude Desktop Messages (POST /v1/messages)", () => {
  it("routes a bare claude-* model to the configured combo's exact id", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"] });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await postMessages(messagesRequest("claude-sonnet-4-5"));

    expect(res.status).toBe(200);
    // The discovery entry id IS the routed model string, so the picker's choice
    // resolves to the configured default combo.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/anthropic/v1/messages");
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.model).toBe("deepseek-chat");
    const json = await res.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("fails closed when the configured combo is unavailable", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: [], isActive: true });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await postMessages(messagesRequest("claude-sonnet-4-5"));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid ingress key before routing", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"] });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await postMessages(messagesRequest("claude-sonnet-4-5", { apiKey: "sk-bogus" }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not apply the Claude default route to an explicitly prefixed model", async () => {
    await seedUpstream();
    await createCombo({ name: COMBO_ID, kind: "llm", models: ["deepseek/deepseek-chat"] });
    await updateSettings({ claudeMessagesRoute: COMBO_ID });

    const res = await postMessages(messagesRequest("deepseek/deepseek-chat"));

    expect(res.status).toBe(200);
    // Explicit provider/model wins; the default combo is not consulted.
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.model).toBe("deepseek-chat");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });
});
