// A channel with several accounts must keep rotating to the next account after
// an *account-level* failure (bad key, unpaid plan, per-account rate limit).
//
// Before the fix, every failed account was charged to the provider/model breaker
// inside the same rotation. Three accounts later the breaker opened and chat.js
// returned early, so on a 4+ account channel the accounts at the bottom of the
// list were never tried — and the open breaker then cooled the whole channel
// down for later requests, including ones that would have hit a healthy account.
//
// These drive the REAL chat.js loop, the REAL markAccountUnavailable lock logic
// and the REAL provider/model breaker against a REAL database, so the routing
// decision under test is the production one. Only the upstream call is stubbed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR is resolved when src/ modules are first imported, so pin it before any
// of them load.
const PROBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-fanout-"));
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
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => []),
  getComboModelsForRequest: vi.fn(() => []),
  getUnsupportedComboRequestCapability: vi.fn(() => null),
}));
vi.mock("@/lib/modelCapabilityOverrides", () => ({
  refreshModelCapabilityOverrides: vi.fn(async () => {}),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");

const UPSTREAM = (status, message) => ({
  source: "http", status, message, body: message,
  retryAfterMs: null, receivedAt: new Date().toISOString(), layer: "provider",
});

function clearBreakers() {
  const g = globalThis.__smProviderBreakers;
  if (g?.providers) g.providers.clear();
  if (g?.overloads) g.overloads.clear();
}

async function setProviderStrategy(strategy) {
  const settingsRepo = await import("../../src/lib/db/repos/settingsRepo.js");
  await settingsRepo.updateSettings({ providerStrategies: { probe: strategy } });
}

function request(model = "probe/model-x") {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer router-key" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

/** Seed `n` active accounts for a throwaway provider, one per priority. */
async function seedAccounts(n, provider = "probe") {
  const existing = await connectionsRepo.getProviderConnections({ provider });
  for (const c of existing) await connectionsRepo.deleteProviderConnection(c.id);
  for (let i = 1; i <= n; i += 1) {
    await connectionsRepo.createProviderConnection({
      provider, authType: "apikey", name: String(i),
      apiKey: `key-${i}`, isActive: true, priority: i,
    });
  }
  const conns = await connectionsRepo.getProviderConnections({ provider, isActive: true });
  return [...conns].sort((a, b) => (a.priority || 0) - (b.priority || 0));
}

/** Make every upstream call fail the same way and record which account ran. */
function failEveryAccount({ status, error }) {
  mocks.attempts.length = 0;
  mocks.handleChatCore.mockImplementation(async ({ credentials }) => {
    mocks.attempts.push(credentials.connectionId);
    return {
      success: false, status, error,
      upstreamError: UPSTREAM(status, error),
      response: new Response("upstream error", { status }),
    };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.attempts.length = 0;
  clearBreakers();
  // Settings persist in the real DB this harness uses, so a strategy set by one
  // case would otherwise leak into the next one.
  await setProviderStrategy({});
  mocks.getModelInfo.mockResolvedValue({ provider: "probe", model: "model-x" });
  mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
});

describe("multi-account fan-out", () => {
  it("rotates intl 11128 to a healthy sibling and skips the rejected account across models", async () => {
    const provider = "codebuddy-intl";
    const [rejected, healthy] = await seedAccounts(2, provider);
    const { parseUpstreamError } = await import("../../open-sse/utils/error.js");
    const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
    const body = { code: 11128, msg: "channel verification failed" };
    const parsed = await parseUpstreamError(new Response(JSON.stringify(body), { status: 400 }), new CodeBuddyIntlExecutor());
    mocks.getModelInfo.mockResolvedValue({ provider, model: "model-x" });
    mocks.handleChatCore.mockImplementation(async ({ credentials }) => {
      mocks.attempts.push(credentials.connectionId);
      if (credentials.connectionId === healthy.id) return { success: true, response: new Response("ok") };
      return { success: false, status: parsed.statusCode, error: parsed.message,
        upstreamError: parsed.upstreamError, response: new Response(JSON.stringify(body), { status: 400 }) };
    });
    expect((await handleChat(request(`${provider}/model-x`))).status).toBe(200);
    expect(mocks.attempts).toEqual([rejected.id, healthy.id]);
    const stored = await connectionsRepo.getProviderConnectionById(rejected.id);
    expect(stored).toMatchObject({ isActive: true, testStatus: "unavailable", errorCode: 400,
      lastUpstreamStatus: 400, lastUpstreamRaw: JSON.stringify(body), lastUpstreamDiagnostics: { code: 11128 } });
    expect(Date.parse(stored.modelLock___all) - Date.now()).toBeGreaterThan(290000);
    expect(Date.parse(stored.modelLock___all) - Date.now()).toBeLessThanOrEqual(300000);
    expect((await connectionsRepo.getProviderConnectionById(healthy.id)).modelLock___all).toBeUndefined();
    // A stale model-specific expiry must not re-admit the blocked account.
    await connectionsRepo.updateProviderConnection(rejected.id, { "modelLock_model-y": new Date(Date.now() - 1000).toISOString() });
    mocks.getModelInfo.mockResolvedValue({ provider, model: "model-y" });
    mocks.attempts.length = 0;
    expect((await handleChat(request(`${provider}/model-y`))).status).toBe(200);
    expect(mocks.attempts).toEqual([healthy.id]);
    const { getProviderModelBreaker } = await import("../../src/sse/services/providerBreaker.js");
    expect((await getProviderModelBreaker(provider, "model-x")).open).toBe(false);
    expect(mocks.updateProviderCredentials).not.toHaveBeenCalled();
  });

  it("drains an all-11128 pool once, retains 400, and never refills or opens the model breaker", async () => {
    const provider = "codebuddy-intl";
    await seedAccounts(4, provider);
    mocks.getModelInfo.mockResolvedValue({ provider, model: "model-x" });
    failEveryAccount({ status: 400, error: JSON.stringify({ code: 11128, msg: "channel verification failed" }) });
    expect((await handleChat(request(`${provider}/model-x`))).status).toBe(400);
    expect(mocks.attempts).toHaveLength(4);
    expect(new Set(mocks.attempts).size).toBe(4);
    expect((await handleChat(request(`${provider}/model-x`))).status).toBe(400);
    expect(mocks.attempts).toHaveLength(4); // later requests do not hit a cooling account
    const { getProviderModelBreaker } = await import("../../src/sse/services/providerBreaker.js");
    expect((await getProviderModelBreaker(provider, "model-x")).open).toBe(false);
    expect(mocks.updateProviderCredentials).not.toHaveBeenCalled();
  });

  it.each([11115, 99999])("keeps unrelated CodeBuddy HTTP 400 code %s terminal without quarantining siblings", async (code) => {
    const provider = "codebuddy-intl";
    const accounts = await seedAccounts(2, provider);
    mocks.getModelInfo.mockResolvedValue({ provider, model: "model-x" });
    failEveryAccount({ status: 400, error: JSON.stringify({ code, msg: "request rejected" }) });
    expect((await handleChat(request(`${provider}/model-x`))).status).toBe(400);
    expect(mocks.attempts).toHaveLength(1);
    for (const account of accounts) {
      expect((await connectionsRepo.getProviderConnectionById(account.id)).modelLock___all).toBeUndefined();
    }
  });

  it.each([429, 502])("keeps an SSE failure's effective %s status through subsequent cooldown requests", async (status) => {
    const [account] = await seedAccounts(1);
    mocks.handleChatCore.mockResolvedValue({
      success: false, status, error: "upstream rejected request",
      upstreamError: { ...UPSTREAM(200, "upstream rejected request"), source: "sse",
        diagnostics: { version: 1, kind: "upstream_error", type: "api_error" } },
      response: new Response("upstream error", { status }),
    });
    expect((await handleChat(request())).status).toBe(status);
    // The transport's 200 is evidence, never the client's failure status.
    const stored = await connectionsRepo.getProviderConnectionById(account.id);
    expect(stored.lastUpstreamStatus).toBe(200);
    expect(stored.lastUpstreamDiagnostics).toEqual({ version: 1, kind: "upstream_error", type: "api_error" });
    expect(stored.errorCode).toBe(status);
    for (const stream of [true, false]) {
      const res = await handleChat(new Request("https://router.test/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "probe/model-x", max_tokens: 10, stream, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(res.status).toBe(status);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect((await res.json()).error.message).toContain("upstream rejected request");
    }
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("does not replay a legacy HTTP 200 errorCode as a successful Messages response", async () => {
    const [account] = await seedAccounts(1);
    await connectionsRepo.updateProviderConnection(account.id, {
      errorCode: 200, lastError: "old SSE failure",
      "modelLock_model-x": new Date(Date.now() + 60_000).toISOString(),
    });
    for (const stream of [true, false]) {
      const res = await handleChat(new Request("https://router.test/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "probe/model-x", max_tokens: 10, stream, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect((await res.json()).error.message).toContain("old SSE failure");
    }
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("tries every account when an account-level error hits each one", async () => {
    for (const n of [2, 3, 4, 5, 6]) {
      await seedAccounts(n);
      failEveryAccount({ status: 401, error: "invalid api key" });

      const res = await handleChat(request());

      expect(mocks.attempts.length, `${n} accounts, all 401`).toBe(n);
      expect(res.status).toBe(401);
    }
  });

  it("does not cap the rotation at the breaker threshold for per-account limits", async () => {
    // 429 is the classic per-account rate limit: it must not open a channel-wide
    // breaker, so all four accounts get their turn.
    await seedAccounts(4);
    failEveryAccount({ status: 429, error: "rate limit exceeded" });

    const res = await handleChat(request());

    expect(mocks.attempts.length).toBe(4);
    expect(res.status).toBe(429);
  });

  it("rotates to a healthy account sitting below several failed ones", async () => {
    const accounts = await seedAccounts(4);
    const healthyId = accounts[3].id;

    // First three accounts are broken; the fourth works.
    mocks.attempts.length = 0;
    mocks.handleChatCore.mockImplementation(async ({ credentials }) => {
      mocks.attempts.push(credentials.connectionId);
      if (credentials.connectionId === healthyId) {
        return { success: true, response: new Response("ok", { status: 200 }) };
      }
      return {
        success: false, status: 401, error: "invalid api key",
        upstreamError: UPSTREAM(401, "invalid api key"),
        response: new Response("nope", { status: 401 }),
      };
    });

    const res = await handleChat(request());

    expect(res.status).toBe(200);
    expect(mocks.attempts.at(-1)).toBe(healthyId);
    expect(mocks.attempts.length).toBe(4);
  });

  it("does not open a channel-wide breaker on account-level failures", async () => {
    // The account locks that follow a 401 are correct and expected; what must NOT
    // happen is the provider/model breaker opening, because that is what cooled the
    // whole channel down for later requests. Assert the breaker state directly so
    // the account cooldowns do not confound the check.
    const { getProviderModelBreaker } = await import("../../src/sse/services/providerBreaker.js");

    await seedAccounts(6);
    failEveryAccount({ status: 401, error: "invalid api key" });
    await handleChat(request());

    const breaker = await getProviderModelBreaker("probe", "model-x");
    expect(breaker.open).toBe(false);
  });

  it("defaults to one overload retry when the channel sets no budget", async () => {
    await seedAccounts(6);
    failEveryAccount({ status: 503, error: "Our servers are currently overloaded" });

    const res = await handleChat(request());

    expect(mocks.attempts.length).toBe(2);
    expect(res.status).toBe(503);
  });

  it("keeps retrying a busy model when the pool is smaller than the budget", async () => {
    // Production shape: 3 accounts, a generous channel budget. Each model-level
    // overload used to exclude an account, so three overloads drained the pool
    // and the request ended as a 503 while the budget was never consulted —
    // measured live (`No more accounts available` fired, `exceeded channel retry
    // budget` did not). The pool must now be refilled for model-level signals.
    await seedAccounts(3);
    await setProviderStrategy({ overloadMaxRetries: 8 });
    failEveryAccount({ status: 503, error: "Our servers are currently overloaded" });

    const res = await handleChat(request());

    // Two passes over the 3 accounts. The second pass stops at the model-overload
    // breaker (default threshold 6), which is a separate, deliberate guard: an
    // overloaded model gets a short breather rather than being hammered for the
    // full retry budget. Before the fix the first pass alone ended the request
    // (3 attempts); now it is 6.
    expect(mocks.attempts.length).toBe(6);
    expect(res.status).toBe(503);
  });

  it("still drains the pool for account-level failures", async () => {
    // The refill is specific to model-level signals. An account that cannot
    // serve the request (here: a 401) must stay excluded, so the loop ends after
    // one pass over the pool rather than retrying the same dead accounts.
    await seedAccounts(3);
    await setProviderStrategy({ overloadMaxRetries: 8 });
    failEveryAccount({ status: 401, error: "Invalid API key provided" });

    const res = await handleChat(request());

    expect(mocks.attempts.length).toBe(3);
    expect(res.status).toBe(401);
  });

  it("does not refill past the channel overload budget", async () => {
    // Termination guard: the refill is bounded by the same budget, so a small
    // budget on a small pool must stop there instead of looping forever.
    await seedAccounts(2);
    await setProviderStrategy({ overloadMaxRetries: 1 });
    failEveryAccount({ status: 503, error: "Our servers are currently overloaded" });

    const res = await handleChat(request());

    expect(mocks.attempts.length).toBe(2);
    expect(res.status).toBe(503);
  });

  it("uses the channel overload retry budget", async () => {
    await seedAccounts(6);
    await setProviderStrategy({ overloadMaxRetries: 3 });
    failEveryAccount({ status: 503, error: "Our servers are currently overloaded" });

    const res = await handleChat(request());

    expect(mocks.attempts.length).toBe(4);
    expect(res.status).toBe(503);
  });

  it("supports zero overload retries for a channel", async () => {
    await seedAccounts(6);
    await setProviderStrategy({ overloadMaxRetries: 0 });
    failEveryAccount({ status: 503, error: "Our servers are currently overloaded" });

    const res = await handleChat(request());

    expect(mocks.attempts.length).toBe(1);
    expect(res.status).toBe(503);
  });

  it.each(["sse_first_output_timeout", "sse_scan_limit"])("records %s without locking accounts or opening the outage breaker", async (origin) => {
    const { getProviderModelBreaker } = await import("../../src/sse/services/providerBreaker.js");
    await seedAccounts(3);
    mocks.handleChatCore.mockImplementation(async ({ credentials }) => {
      mocks.attempts.push(credentials.connectionId);
      return {
        success: false, status: 503, error: "Timed out waiting for first upstream output",
        upstreamError: { source: "sse", status: 200, layer: "gateway", origin,
          message: "Timed out waiting for first upstream output", body: "event: response.created", receivedAt: new Date().toISOString() },
        response: new Response("scan stopped", { status: 503 }),
      };
    });

    expect((await handleChat(request())).status).toBe(503);
    expect(mocks.attempts).toHaveLength(1);
    expect((await getProviderModelBreaker("probe", "model-x")).open).toBe(false);
    const account = await connectionsRepo.getProviderConnectionById(mocks.attempts[0]);
    expect(account.lastUpstreamLayer).toBe("gateway");
    expect(account.lastUpstreamStatus).toBe(200);
    expect(account.lastUpstreamRaw).toBe("event: response.created");
    expect(account.testStatus).not.toBe("degraded");
    expect(Object.keys(account).some((key) => key.startsWith("modelLock_"))).toBe(false);
  });

  it("still opens the breaker for a genuine upstream outage (5xx)", async () => {
    // A real upstream server error is channel-level, not account-level: the long
    // breaker is the intended protection and must survive this fix.
    const { getProviderModelBreaker } = await import("../../src/sse/services/providerBreaker.js");

    await seedAccounts(6);
    failEveryAccount({ status: 500, error: "internal server error" });

    const res = await handleChat(request());

    expect(mocks.attempts.length).toBeLessThan(6);
    expect(res.status).toBe(500);
    expect((await getProviderModelBreaker("probe", "model-x")).open).toBe(true);
  });
});
