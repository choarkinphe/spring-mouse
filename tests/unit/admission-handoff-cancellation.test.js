// Drive the real account selection and chat handler across the lease handoff.
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
  attempts: [], controller: null, lastCredentials: null,
}));

// Keep the REAL auth.js (getProviderCredentials, markAccountUnavailable); only
// the API-key gate is stubbed so the test key needs no registration.
vi.mock("../../src/sse/services/auth.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    getProviderCredentials: async (...args) => {
      const credentials = await actual.getProviderCredentials(...args);
      mocks.lastCredentials = credentials;
      mocks.controller?.abort("cancel during admission handoff");
      return credentials;
    },
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


const { getLocalSlotStatus } = await import("../../src/lib/redis/connectionSlots.js");
describe("cancel after real slot admission", () => {
  it("must release the admitted slot before returning 499", async () => {
    await seedAccounts(1);
    mocks.controller = new AbortController();
    const req = new Request(request(), { signal: mocks.controller.signal });
    try {
      const res = await handleChat(req);
      expect(mocks.handleChatCore).not.toHaveBeenCalled();
      expect(res.status).toBe(499);
      expect(getLocalSlotStatus().active).toBe(0);
    } finally {
      await mocks.lastCredentials?.releaseRouteSlot?.();
      mocks.controller = null;
    }
  });
});


describe("revalidate the account at admission", () => {
  it("skips an account disabled while its request waits", async () => {
    const [account] = await seedAccounts(1);
    await setProviderStrategy({maxConcurrentStreams: 1, queueTimeoutMs: 3000});
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const options = {reserveSlot: true, body:{messages:[]}};
    const held = await getProviderCredentials("probe", null, "model-x", options);
    const waiting = getProviderCredentials("probe", null, "model-x", options);
    let next;
    try {
      await new Promise(resolve => setTimeout(resolve,30));
      await connectionsRepo.updateProviderConnection(account.id, {isActive:false});
      const fresh = await connectionsRepo.createProviderConnection({provider:"probe",authType:"apikey",apiKey:"fresh",name:"fresh",isActive:true,priority:2});
      await held.releaseRouteSlot();
      next = await waiting;
      expect(next.connectionId).toBe(fresh.id);
    } finally {
      await held.releaseRouteSlot();
      await next?.releaseRouteSlot?.();
    }
  });
});


it("does not dispatch or cool down an account if setup consumes the request budget", async () => {
  const [account] = await seedAccounts(1);
  const { REQUEST_OVERLOAD_BUDGET_MS } = await import("../../open-sse/config/runtimeConfig.js");
  const now = Date.now.bind(Date);
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => {
    vi.spyOn(Date, "now").mockImplementation(() => now() + REQUEST_OVERLOAD_BUDGET_MS + 1000);
    return credentials;
  });
  try {
    const response = await handleChat(request());
    expect(response.status).toBe(504);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(getLocalSlotStatus().active).toBe(0);
    const updated = await connectionsRepo.getProviderConnectionById(account.id);
    expect(updated.testStatus).not.toBe("error");
    expect(globalThis.__smProviderBreakers?.providers?.size || 0).toBe(0);
  } finally { vi.restoreAllMocks(); }
});


it("keeps two long requests parallel on a 15-slot account when the provider gate is disabled", async () => {
  await seedAccounts(1);
  await setProviderStrategy({hardConcurrencyEnabled:false,maxConcurrentStreams:15,providerMaxConcurrentStreams:50,queueTimeoutMs:50});
  const {getProviderCredentials} = await import("../../src/sse/services/auth.js");
  const options = {reserveSlot:true,body:{messages:[{role:"user",content:"x".repeat(1_000_000)}]}};
  const admitted=[];
  try {
    admitted.push(await getProviderCredentials("probe",null,"model-x",options));
    admitted.push(await getProviderCredentials("probe",null,"model-x",options));
    expect(admitted.map(c => c.admission.weight)).toEqual([7,7]);
    await expect(getProviderCredentials("probe",null,"model-x",options)).rejects.toMatchObject({reason:"queue_timeout"});
  } finally { await Promise.all(admitted.map(c => c.releaseRouteSlot())); }
});
