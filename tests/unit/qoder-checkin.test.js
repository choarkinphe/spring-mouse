import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ stat: vi.fn(), readdir: vi.fn(), execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: native.stat, readdir: native.readdir }));
vi.mock("node:child_process", () => ({ execFile: native.execFile }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => globalThis.fetch(...args) }));
import { performQoderCheckin, qoderCheckinDate, readQoderMachineIdentity } from "../../src/lib/services/qoderCheckin.js";

const NOW = Date.parse("2026-10-28T03:00:00Z");
const START = Date.parse("2026-10-28T02:00:00Z");
const END = Date.parse("2026-10-29T01:59:00Z");
const NEXT = Date.parse("2026-10-29T02:01:00Z");
const IDENTITY = { "Cosy-MachineToken": "native-sdk-device-token", "Cosy-MachineType": "cfe-fixture" };
const account = (overrides = {}) => ({
  provider: "qoder-cn", accessToken: "dt-fixture", refreshToken: "drt-fixture",
  expiresAt: new Date(NOW + 86400000).toISOString(),
  providerSpecificData: { userId: "user-fixture", region: "cn" }, ...overrides,
});
const campaign = (overrides = {}) => ({
  campaignId: "fixture/campaign", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE",
  startAt: START / 1000, endAt: END / 1000, benefit: { kind: "CREDITS", amount: 100 }, ...overrides,
});
const missing = async () => { throw new Error("not installed"); };
const json = (body, status = 200) => Response.json(body, { status });
const run = (connection, options = {}) => performQoderCheckin(connection, {
  now: () => NOW, readMachineIdentity: missing, ...options,
});
const server = (campaigns = [campaign()], claim = { status: "CLAIMED", benefit: { amount: 100 } }) =>
  vi.fn(async (_url, init) => json(init.method === "POST" ? claim : { campaigns }));

beforeEach(() => {
  vi.clearAllMocks();
  native.stat.mockRejectedValue(new Error("ENOENT"));
  native.readdir.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Qoder campaign check-in", () => {
  it("uses the 10:00 Beijing campaign day regardless of local midnight", () => {
    expect(qoderCheckinDate(Date.parse("2026-10-28T01:59:59Z"))).toBe("2026-10-27");
    expect(qoderCheckinDate(Date.parse("2026-10-28T02:00:00Z"))).toBe("2026-10-28");
    expect(qoderCheckinDate(Date.parse("2026-10-28T16:01:00Z"))).toBe("2026-10-28");
  });

  it("claims CN daily credits without a native helper, binding the host and proxy", async () => {
    const fetch = server();
    const proxy = { proxyUrl: "http://proxy.invalid" };
    const lease = vi.fn(async () => true);
    const output = await run(account(), { fetch, proxy, renewLease: lease });
    expect(output).toMatchObject({ ok: true, status: "success", reward: 100, nextAttemptAt: NEXT, successDate: "2026-10-28" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns",
      "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/fixture%2Fcampaign/claim",
    ]);
    for (const [, init, sentProxy] of fetch.mock.calls) {
      expect(sentProxy).toBe(proxy);
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({ Authorization: "Bearer dt-fixture", "Cosy-ClientType": "10", "User-Agent": "Qoder" });
      expect(init.headers["Cosy-MachineToken"]).toBeUndefined();
    }
    expect(fetch.mock.calls[1][1].body).toBe("{}");
    expect(lease).toHaveBeenCalledOnce();
  });

  it("refuses conflicting provider regions and inactive accounts before any network or native calls", async () => {
    const fetch = vi.fn(), identity = vi.fn();
    expect((await run(account({ providerSpecificData: { region: "global" } }), { fetch, readMachineIdentity: identity })).status).toBe("unsupported");
    expect((await run(account({ isActive: false }), { fetch, readMachineIdentity: identity })).status).toBe("unsupported");
    expect(fetch).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
  });

  it("global claims require real native identity, never a chat UUID", async () => {
    const fetch = vi.fn();
    expect(await run(account({ provider: "qoder", providerSpecificData: { userId: "u", machineId: "uuid" } }), { fetch }))
      .toMatchObject({ ok: false, status: "runtime_missing" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses official native identity to claim an eligible global campaign", async () => {
    const fetch = server();
    const readMachineIdentity = vi.fn(async () => ({ ...IDENTITY, "Cosy-MachineCode": "native-code", "Cosy-MachineId": "stable-local-id" }));
    expect(await run(account({ provider: "qoder", providerSpecificData: { userId: "u" } }), { fetch, readMachineIdentity }))
      .toMatchObject({ ok: true, status: "success", reward: 100 });
    expect(readMachineIdentity).toHaveBeenCalledWith("global", "u");
    expect(fetch.mock.calls[0][0]).toBe("https://openapi.qoder.sh/sash/api/v1/me/campaigns");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].method).toBe("POST");
    expect(fetch.mock.calls[1][1].headers).toMatchObject({ ...IDENTITY, "Cosy-MachineCode": "native-code", "Cosy-MachineId": "stable-local-id" });
  });

  it("does not fabricate eligibility if native identity gets only VIEW_DETAILS", async () => {
    const fetch = server([{ actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" }]);
    expect(await run(account({ provider: "qoder", providerSpecificData: { region: "global", userId: "u" } }), { fetch, readMachineIdentity: async () => IDENTITY }))
      .toMatchObject({ ok: false, status: "ineligible" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not replay an already claimed global campaign", async () => {
    const fetch = server([campaign({ claimStatus: "CLAIMED" })]);
    expect(await run(account({ provider: "qoder", providerSpecificData: { region: "global", userId: "u" } }), { fetch, readMachineIdentity: async () => IDENTITY }))
      .toMatchObject({ ok: true, status: "already_checked_in" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not claim a campaign already claimed in this window", async () => {
    const fetch = server([campaign({ claimStatus: "CLAIMED" })]);
    expect(await run(account(), { fetch })).toMatchObject({ ok: true, status: "already_checked_in", reward: 100, nextAttemptAt: NEXT });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("claims the previous provider day before 10:00, with retry at the opening", async () => {
    const fetch = server([campaign({ startAt: (START - 86400000) / 1000, endAt: (END - 86400000) / 1000 })]);
    const output = await run(account(), { fetch, now: () => START - 120000 });
    expect(output).toMatchObject({ status: "success", successDate: "2026-10-27", nextAttemptAt: START + 60000 });
  });

  it("accepts milliseconds, nested claims and zero rewards", async () => {
    const fetch = server([campaign({ startAt: START, endAt: END })], { data: { status: "CLAIMED", benefit: { amount: "0" } } });
    expect(await run(account(), { fetch })).toMatchObject({ status: "success", reward: 0, nextAttemptAt: NEXT });
  });

  it("honors a multi-day campaign's end and does not hardcode 100 credits", async () => {
    const fetch = server([campaign({ endAt: (START + 3 * 86400000) / 1000, benefit: { amount: 25 } })], { status: "CLAIMED" });
    expect(await run(account(), { fetch })).toMatchObject({ reward: 25, nextAttemptAt: START + 3 * 86400000 + 60000 });
  });

  it("does not claim future, expired, malformed or non-credit campaigns", async () => {
    for (const entries of [
      [campaign({ startAt: (NOW + 3600000) / 1000 })],
      [campaign({ endAt: NOW / 1000 })],
      [campaign({ startAt: null })],
      [campaign({ campaignId: "" })],
      [campaign({ benefit: { kind: "OTHER", amount: 100 } })],
      [campaign({ actionType: "VIEW_DETAILS" })],
    ]) {
      const fetch = server(entries);
      expect((await run(account(), { fetch })).ok).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it("returns next opening for a future campaign instead of a midnight terminal marker", async () => {
    const fetch = server([campaign({ startAt: (NOW + 3600000) / 1000 })]);
    expect(await run(account(), { fetch })).toMatchObject({ status: "error", nextAttemptAt: NOW + 3600000 + 60000 });
  });

  it("stops immediately when the claim lease was lost", async () => {
    const fetch = server();
    expect(await run(account(), { fetch, renewLease: async () => false })).toMatchObject({ skipped: "lease_lost", ok: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not claim after the campaign expires during lease renewal", async () => {
    let time = NOW;
    const fetch = server();
    const output = await run(account(), {
      fetch, now: () => time, renewLease: async () => { time = END; return true; },
    });
    expect(output.ok).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses exactly one minute of safety room when between campaigns", async () => {
    const fetch = server([campaign({
      claimStatus: "CLAIMED", startAt: (START - 86400000) / 1000, endAt: (END - 86400000) / 1000,
    })]);
    expect(await run(account(), { fetch, now: () => START - 30000 })).toMatchObject({
      status: "error", nextAttemptAt: START + 60000,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refreshes an unauthorized device token once and never swaps regions", async () => {
    const fetch = vi.fn(async (_url, init) => init.headers.Authorization === "Bearer dt-fixture"
      ? json({}, 401) : json(init.method === "POST" ? { status: "CLAIMED" } : { campaigns: [campaign()] }));
    const refreshConnection = vi.fn(async (connection) => ({ ...connection, accessToken: "dt-new" }));
    expect((await run(account(), { fetch, refreshConnection })).status).toBe("success");
    expect(refreshConnection).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    const wrongRegion = vi.fn(async (connection) => ({ ...connection, providerSpecificData: { region: "global" }, accessToken: "dt-new" }));
    const refused = vi.fn(async () => json({}, 401));
    expect((await run(account(), { fetch: refused, refreshConnection: wrongRegion })).ok).toBe(false);
    expect(refused).toHaveBeenCalledOnce();
  });

  it("refreshes before using a nearly expired token", async () => {
    const fetch = server();
    const refreshConnection = vi.fn(async (connection) => ({ ...connection, accessToken: "dt-fresh", expiresAt: new Date(NOW + 86400000).toISOString() }));
    expect((await run(account({ expiresAt: new Date(NOW).toISOString() }), { fetch, refreshConnection })).ok).toBe(true);
    expect(refreshConnection).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer dt-fresh");
  });

  it("never refreshes or replays a claim rejected by the vendor's own-app gate", async () => {
    for (const status of [401, 403]) {
      const fetch = vi.fn(async (_url, init) => init.method === "GET" ? json({ campaigns: [campaign()] }) : json({}, status));
      const refreshConnection = vi.fn(async (connection) => ({ ...connection, accessToken: "dt-fresh" }));
      const renewLease = vi.fn(async () => true);
      expect(await run(account(), { fetch, refreshConnection, renewLease })).toMatchObject({ ok: false, status: "own_app" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(refreshConnection).not.toHaveBeenCalled();
      expect(renewLease).toHaveBeenCalledOnce();
    }
  });

  it("does not report HTTP success as a successful claim without CLAIMED", async () => {
    for (const reply of [{ status: "INELIGIBLE" }, {}, { data: null }, { status: "CLAIMABLE" }]) {
      const fetch = server([campaign()], reply);
      expect((await run(account(), { fetch })).ok).toBe(false);
    }
  });

  it("never leaks raw upstream errors or retries an ambiguous claim failure", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init.method === "POST") throw new Error("secret-token-sensitive-upstream");
      return json({ campaigns: [campaign()] });
    });
    const output = await run(account(), { fetch });
    expect(output).toMatchObject({ ok: false, status: "error" });
    expect(JSON.stringify(output)).not.toContain("secret");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await run(account(), { fetch: async () => json({}, 403) })).message).toContain("重新授权");
    expect((await run(account(), { fetch: async () => json({}) })).status).toBe("error");
  });

  it("exchanges PAT credentials for a regional job token; never sends the PAT to campaigns", async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url.includes("jobToken/exchange")) return json({ token: "jt-fixture", expires_in: 86400000 });
      if (url.includes("userinfo")) return json({ id: "pat-user" });
      return json(init.method === "POST" ? { status: "CLAIMED" } : { campaigns: [campaign()] });
    });
    vi.stubGlobal("fetch", fetch);
    const connection = account({ accessToken: undefined, refreshToken: undefined, apiKey: "pt-checkin-test-unique" });
    expect((await run(connection, { fetch })).status).toBe("success");
    expect(calls[0].url).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
    for (const { init } of calls.filter(({ url }) => url.includes("/campaigns"))) expect(init.headers.Authorization).toBe("Bearer jt-fixture");
  });
});

describe("official native identity helper", () => {
  it("does not execute anything when no supported installation exists", async () => {
    await expect(readQoderMachineIdentity("global", "missing-user")).rejects.toThrow(/unavailable/);
    expect(native.execFile).not.toHaveBeenCalled();
  });

  it("executes only the discovered helper with regional environment and account stdin", async () => {
    native.stat.mockImplementation(async (path) => {
      if (!String(path).includes("resources/umid/runtime-info") && !String(path).includes("Resources/umid/runtime-info")) throw new Error("ENOENT");
      return { isFile: () => true, mode: 0o755, uid: typeof process.getuid === "function" ? process.getuid() : 0 };
    });
    const input = vi.fn();
    native.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, JSON.stringify({ machineToken: "sdk-token", machineType: "cfe-type" })));
      return { stdin: { on: vi.fn(), end: input } };
    });
    const output = await readQoderMachineIdentity("cn", "native-user-fixture");
    expect(output).toEqual({ "Cosy-MachineToken": "sdk-token", "Cosy-MachineType": "cfe-type" });
    const [, args, options] = native.execFile.mock.calls[0];
    expect(args).toEqual(process.platform === "linux" ? ["0"] : ["0", "--account-stdin"]);
    expect(options.timeout).toBe(20000);
    if (process.platform !== "linux") expect(JSON.parse(input.mock.calls[0][0])).toEqual({ account: "native-user-fixture" });
    await readQoderMachineIdentity("cn", "native-user-fixture");
    expect(native.execFile).toHaveBeenCalledOnce();
  });
});
