import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fail closed at import boundaries: constructing the default service must never
// open the real DB, initialize the proxy implementation, or refresh credentials.
const boundaries = vi.hoisted(() => {
  const forbidden = (name) => vi.fn(() => { throw new Error(`Unexpected real dependency: ${name}`); });
  return {
    load: forbidden("loadConnection"), get: forbidden("getState"),
    update: forbidden("updateState"), connection: forbidden("updateConnection"),
    fetch: forbidden("proxyAwareFetch"), refresh: forbidden("refreshCodebuddyToken"),
  };
});
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnectionById: boundaries.load,
  updateProviderConnectionHealth: boundaries.connection,
}));
vi.mock("@/lib/db/repos/checkinRepo.js", () => ({
  getCheckinState: boundaries.get, updateCheckinState: boundaries.update,
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: boundaries.fetch }));
vi.mock("open-sse/services/tokenRefresh.js", () => ({ refreshCodebuddyToken: boundaries.refresh }));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  getCredentialExpiryMs: (connection) => connection.expiresAt ? Date.parse(connection.expiresAt) : null,
}));

import { createCodeBuddyCheckinService, publicCheckinState } from "@/lib/services/codebuddyCheckin.js";
import { CODEBUDDY_CHECKIN as config, codeBuddyCheckinDate } from "@/shared/config/codebuddyCheckin.js";

const ID = "cn-oauth-1";
const BASE_TIME = Date.parse("2026-10-22T04:00:00Z");
const jsonResponse = (code = 0, data = {}, status = 200) => ({
  status, ok: status >= 200 && status < 300, json: vi.fn().mockResolvedValue({ code, data }),
});
const activity = (data = {}) => jsonResponse(0, { active: true, today_checked_in: false, ...data });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture({ connection = {}, state = {}, time = BASE_TIME } = {}) {
  let clock = time;
  let storedConnection = {
    id: ID, provider: "codebuddy-cn", authType: "oauth", isActive: true,
    accessToken: "access-secret", refreshToken: "refresh-secret",
    providerSpecificData: { codebuddyUid: "uid-123" }, ...connection,
  };
  let storedState = { enabled: false, ...state };
  const patches = [];
  const deps = {
    loadConnection: vi.fn(async () => structuredClone(storedConnection)),
    getState: vi.fn(async () => structuredClone(storedState)),
    // Apply the callback atomically, like the real repository transaction, but
    // share this store across independent service instances to test the lease.
    updateState: vi.fn(async (_id, updater) => {
      const patch = updater(structuredClone(storedState));
      if (patch) {
        patches.push(structuredClone(patch));
        storedState = { ...storedState, ...patch };
      }
      return structuredClone(storedState);
    }),
    updateConnection: vi.fn(async (_id, updater) => {
      const { update } = updater(structuredClone(storedConnection));
      if (update) storedConnection = { ...storedConnection, ...update };
      return structuredClone(storedConnection);
    }),
    fetch: vi.fn(async (url) => url.endsWith(config.statusPath)
      ? activity() : jsonResponse(0, { credit: 25 })),
    refresh: vi.fn().mockResolvedValue(null),
    now: vi.fn(() => clock),
  };
  return {
    ...deps, patches, service: createCodeBuddyCheckinService(deps),
    anotherService: () => createCodeBuddyCheckinService(deps),
    state: () => structuredClone(storedState), connection: () => structuredClone(storedConnection),
    setTime: (value) => { clock = value; },
    replaceState: (patch) => { storedState = { ...storedState, ...patch }; },
    replaceConnection: (patch) => { storedConnection = { ...storedConnection, ...patch }; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected global network call"); }));
});
afterEach(() => {
  for (const mock of Object.values(boundaries)) expect(mock).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CodeBuddy check-in eligibility and opt-in", () => {
  it("rejects a missing connection without state writes or upstream calls", async () => {
    const f = fixture();
    f.loadConnection.mockResolvedValue(null);
    expect(await f.service.run(ID)).toEqual({ ok: false, httpStatus: 404, message: "账号不存在" });
    expect(f.updateState).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "codebuddy", authType: "oauth" },
    { provider: "codebuddy-cn", authType: "apikey" },
    { provider: "other", authType: "oauth" },
    { provider: "codebuddy-cn", authType: undefined },
  ])("limits check-in to CN OAuth: %j", async (connection) => {
    const f = fixture({ connection });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, httpStatus: 400, message: expect.stringContaining("国内版 OAuth") });
    expect(f.updateState).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects inactive accounts and exposes only public state", async () => {
    const f = fixture({ connection: { isActive: false }, state: { leaseId: "private-lease" } });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, httpStatus: 400, message: "请先启用账号", checkin: { enabled: false } });
    expect(f.getState).toHaveBeenCalledWith(ID);
    expect(f.updateState).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, false, "true", 1])("does not automatically check in without explicit opt-in (%s)", async (enabled) => {
    const f = fixture({ state: { enabled } });
    expect(await f.service.run(ID, { automatic: true })).toMatchObject({ ok: false, skipped: "disabled", checkin: { enabled: false } });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.patches).toEqual([]);
  });

  it("allows manual check-in by default, without opting in automatically", async () => {
    const f = fixture();
    const result = await f.service.run(ID);
    expect(result).toMatchObject({ ok: true, status: "success", reward: 25, checkin: { enabled: false } });
    expect(f.state()).toMatchObject({ enabled: false, lastSuccessDate: "2026-10-22", leaseId: null, leaseUntil: 0 });
  });

  it("persists opt-in changes without changing credentials or making requests", async () => {
    const f = fixture({ state: { status: "error", leaseId: "hidden" } });
    expect(await f.service.setEnabled(ID, true)).toMatchObject({ enabled: true, status: "error" });
    expect(await f.service.setEnabled(ID, false)).toMatchObject({ enabled: false, status: "error" });
    expect(f.patches).toEqual([{ enabled: true }, { enabled: false }]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.updateConnection).not.toHaveBeenCalled();
  });
});

describe("Beijing day idempotence and retry state", () => {
  it("uses Beijing midnight rather than UTC midnight", () => {
    expect(codeBuddyCheckinDate(Date.parse("2026-10-22T15:59:59.999Z"))).toBe("2026-10-22");
    expect(codeBuddyCheckinDate(Date.parse("2026-10-22T16:00:00.000Z"))).toBe("2026-10-23");
  });

  it("skips repeat manual and automatic claims on the same Beijing day, and retries next day", async () => {
    const f = fixture({ state: { enabled: true }, time: Date.parse("2026-10-22T00:00:00Z") });
    expect((await f.service.run(ID)).status).toBe("success");
    f.setTime(Date.parse("2026-10-22T15:59:59Z"));
    for (const automatic of [false, true]) {
      expect(await f.anotherService().run(ID, { automatic })).toMatchObject({ ok: true, skipped: "today", message: "今日已签到" });
    }
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.setTime(Date.parse("2026-10-22T16:00:00Z"));
    expect(await f.service.run(ID, { automatic: true })).toMatchObject({ ok: true, status: "success", checkin: { lastSuccessDate: "2026-10-23" } });
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it("cools down automatic errors for one hour, then retries at the boundary", async () => {
    const f = fixture({ state: { enabled: true } });
    f.fetch.mockResolvedValueOnce(jsonResponse(9000, {}, 500));
    expect(await f.service.run(ID, { automatic: true })).toMatchObject({ ok: false, status: "error", checkin: { lastSuccessDate: null } });
    expect(f.state()).toMatchObject({ retryAfter: BASE_TIME + config.retryMs, leaseId: null, terminalDate: null });
    f.setTime(BASE_TIME + config.retryMs - 1);
    expect(await f.service.run(ID, { automatic: true })).toMatchObject({ skipped: "cooldown" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.setTime(BASE_TIME + config.retryMs);
    expect((await f.service.run(ID, { automatic: true })).status).toBe("success");
    expect(f.state().retryAfter).toBe(0);
  });

  it("allows an explicit manual retry during automatic error cooldown", async () => {
    const f = fixture({ state: { enabled: true, retryAfter: BASE_TIME + config.retryMs } });
    expect(await f.service.run(ID, { automatic: true })).toMatchObject({ skipped: "cooldown" });
    expect((await f.service.run(ID)).status).toBe("success");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([[1002, "ineligible"], [1003, "ended"]])("retries terminal business code %s on the next Beijing day", async (code, status) => {
    const f = fixture({ state: { enabled: true }, time: Date.parse("2026-10-22T15:59:00Z") });
    f.fetch.mockResolvedValueOnce(jsonResponse(code));
    expect((await f.service.run(ID, { automatic: true })).status).toBe(status);
    expect(f.state()).toMatchObject({ terminalDate: "2026-10-22", retryAfter: 0 });
    expect(await f.service.run(ID, { automatic: true })).toMatchObject({ skipped: "cooldown" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.setTime(Date.parse("2026-10-22T16:00:00Z"));
    expect((await f.service.run(ID, { automatic: true })).status).toBe("success");
    expect(f.state().terminalDate).toBeNull();
  });

  it("never records today's success on failure or erases an older successful date", async () => {
    const f = fixture({ state: { lastSuccessDate: "2026-10-21" } });
    f.fetch.mockRejectedValue(new Error("upstream failed"));
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error", checkin: { lastSuccessDate: "2026-10-21" } });
    expect(f.patches.every((patch) => !("lastSuccessDate" in patch))).toBe(true);
    expect(f.state().leaseUntil).toBe(0);
  });
});

describe("persistent lease across service instances", () => {
  it.each([[false, true], [true, false], [true, true], [false, false]])(
    "serializes first automatic=%s and second automatic=%s", async (firstAuto, secondAuto) => {
      const f = fixture({ state: { enabled: true } });
      const started = deferred();
      const pending = deferred();
      f.fetch.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
      const first = f.service.run(ID, { automatic: firstAuto });
      await started.promise;
      expect(f.state()).toMatchObject({ leaseId: expect.any(String), leaseUntil: BASE_TIME + config.leaseMs });
      expect(await f.anotherService().run(ID, { automatic: secondAuto })).toMatchObject({ ok: false, skipped: "running" });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      pending.resolve(activity());
      expect((await first).status).toBe("success");
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.state().leaseId).toBeNull();
    },
  );

  it("honors a lease persisted before this service was created, then recovers when expired", async () => {
    const f = fixture({ state: { leaseId: "other-process", leaseUntil: BASE_TIME + 1 } });
    expect(await f.service.run(ID)).toMatchObject({ skipped: "running" });
    expect(f.fetch).not.toHaveBeenCalled();
    f.setTime(BASE_TIME + 1);
    expect((await f.anotherService().run(ID)).status).toBe("success");
  });

  it("does not let an old request overwrite a newer lease owner's state", async () => {
    const f = fixture();
    const started = deferred();
    const pending = deferred();
    f.fetch.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const first = f.service.run(ID);
    await started.promise;
    f.replaceState({ leaseId: "replacement-owner", leaseUntil: BASE_TIME + config.leaseMs * 2, status: "replacement-status" });
    pending.resolve(activity());
    expect(await first).toMatchObject({ ok: false, skipped: "lease_lost" });
    expect(f.state()).toMatchObject({ leaseId: "replacement-owner", status: "replacement-status" });
    expect(f.state().lastSuccessDate).toBeUndefined();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.patches).toHaveLength(1);
  });

  it("renews the owned lease atomically immediately before claiming", async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => {
      f.setTime(BASE_TIME + config.leaseMs - 1);
      return activity();
    });
    expect((await f.service.run(ID)).status).toBe("success");
    expect(f.updateState).toHaveBeenCalledTimes(3);
    expect(f.patches[1]).toEqual({ leaseUntil: BASE_TIME + config.leaseMs * 2 - 1 });
    expect(f.updateState.mock.invocationCallOrder[1]).toBeLessThan(f.fetch.mock.invocationCallOrder[1]);
  });

  it("does not claim when its own lease expires before the status response returns", async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => {
      f.setTime(BASE_TIME + config.leaseMs);
      return activity();
    });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, skipped: "lease_lost" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.patches).toHaveLength(1);
    expect(f.state().lastSuccessDate).toBeUndefined();
    expect(f.state().retryAfter).toBeUndefined();
  });

  it.each([false, true])("expired worker A cannot claim after worker B succeeds (B automatic=%s)", async (automatic) => {
    const f = fixture({ state: { enabled: true } });
    const startedA = deferred();
    const pendingA = deferred();
    f.fetch.mockImplementationOnce(() => { startedA.resolve(); return pendingA.promise; });
    const workerA = f.service.run(ID);
    await startedA.promise;
    const oldLeaseId = f.state().leaseId;
    f.setTime(BASE_TIME + config.leaseMs);
    expect(await f.anotherService().run(ID, { automatic })).toMatchObject({ ok: true, status: "success" });
    const completedB = f.state();
    expect(completedB).toMatchObject({ leaseId: null, leaseUntil: 0, status: "success", lastSuccessDate: "2026-10-22" });
    expect(f.patches[1].leaseId).not.toBe(oldLeaseId);
    pendingA.resolve(activity());
    expect(await workerA).toMatchObject({ ok: false, skipped: "lease_lost", checkin: { status: "success", lastSuccessDate: "2026-10-22" } });
    expect(f.state()).toEqual(completedB);
    expect(f.fetch.mock.calls.filter(([url]) => url.endsWith(config.claimPath))).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not claim when today's success was persisted while it waited for activity", async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => {
      f.replaceState({ lastSuccessDate: "2026-10-22", status: "already_checked_in" });
      return activity();
    });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, skipped: "lease_lost", checkin: { lastSuccessDate: "2026-10-22" } });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.patches).toHaveLength(1);
  });
});

describe("activity, claim and business response validation", () => {
  it("sends the WorkBuddy protocol and persists a successful numeric reward", async () => {
    const f = fixture();
    expect(await f.service.run(ID)).toMatchObject({ ok: true, status: "success", reward: 25 });
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${config.origin}${config.statusPath}`, `${config.origin}${config.claimPath}`,
    ]);
    for (const [, options] of f.fetch.mock.calls) {
      expect(options).toMatchObject({ method: "POST", body: "{}", redirect: "error", signal: expect.any(AbortSignal), headers: {
        Authorization: "Bearer access-secret", "X-User-Id": "uid-123", "User-Agent": "WorkBuddy/5.5.6",
        "X-Domain": "copilot.tencent.com", "X-IDE-Type": "WorkBuddy", "X-Product": "SaaS",
      } });
    }
    expect(f.state()).toMatchObject({ status: "success", reward: 25, lastSuccessDate: "2026-10-22", lastAttemptAt: "2026-10-22T04:00:00.000Z" });
  });

  it.each(["status", "claim"])("maps business 1001/1002/1003 from %s responses", async (phase) => {
    for (const [code, status, ok] of [[1001, "already_checked_in", true], [1002, "ineligible", false], [1003, "ended", false]]) {
      const f = fixture();
      if (phase === "claim") f.fetch.mockResolvedValueOnce(activity());
      f.fetch.mockResolvedValueOnce(jsonResponse(code));
      const result = await f.service.run(ID);
      expect(result).toMatchObject({ ok, status });
      expect(f.fetch).toHaveBeenCalledTimes(phase === "status" ? 1 : 2);
      expect(f.state().lastSuccessDate).toBe(ok ? "2026-10-22" : undefined);
      expect(f.state().terminalDate).toBe(ok ? null : "2026-10-22");
    }
  });

  it.each([
    [{ active: false, today_checked_in: false }, "ended", false],
    [{ active: true, today_checked_in: true }, "already_checked_in", true],
    [{ active: false, today_checked_in: true }, "ended", false],
  ])("does not claim when activity is %j", async (data, status, ok) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(jsonResponse(0, data));
    expect(await f.service.run(ID)).toMatchObject({ ok, status });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { active: true }, { active: "true", today_checked_in: false }, { active: true, today_checked_in: 0 }])(
    "rejects malformed activity %j without claiming", async (data) => {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(jsonResponse(0, data));
      expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error" });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.state().lastSuccessDate).toBeUndefined();
    },
  );

  it.each([null, "bad", undefined, []])("rejects a claim without a record payload (%s)", async (data) => {
    const f = fixture();
    const response = jsonResponse();
    response.json.mockResolvedValue({ code: 0, data });
    f.fetch.mockResolvedValueOnce(activity()).mockResolvedValueOnce(response);
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error" });
    expect(f.state().lastSuccessDate).toBeUndefined();
  });

  it.each([NaN, Infinity, undefined, null, "", " ", "bad", -1, "-1", {}, true])("does not expose an invalid or negative credit (%s)", async (credit) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(activity()).mockResolvedValueOnce(jsonResponse(0, { credit }));
    expect(await f.service.run(ID)).toMatchObject({ ok: true, status: "success", reward: null });
    expect(f.state().reward).toBeNull();
  });

  it.each(["25", "0", "2.5"])("accepts numeric-string credit %s", async (credit) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(activity()).mockResolvedValueOnce(jsonResponse(0, { credit }));
    expect(await f.service.run(ID)).toMatchObject({ ok: true, status: "success", reward: Number(credit) });
  });

  it.each(["status", "claim"])("normalizes digit-string business codes from %s", async (phase) => {
    for (const [code, status] of [["1001", "already_checked_in"], ["1002", "ineligible"], ["1003", "ended"]]) {
      const f = fixture();
      if (phase === "claim") f.fetch.mockResolvedValueOnce(activity());
      f.fetch.mockResolvedValueOnce(jsonResponse(code));
      expect((await f.service.run(ID)).status).toBe(status);
    }
  });

  it("normalizes digit-string zero codes for activity, claim, and summary", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(jsonResponse("0", { active: true, today_checked_in: false }))
      .mockResolvedValueOnce(jsonResponse("0", { credit: "25" }));
    expect(await f.service.run(ID)).toMatchObject({ ok: true, status: "success", reward: 25 });
    const restricted = fixture();
    restricted.fetch.mockResolvedValueOnce(jsonResponse(401, {}, 401)).mockResolvedValueOnce(jsonResponse("0"));
    expect((await restricted.service.run(ID)).status).toBe("own_app");
    expect(restricted.refresh).not.toHaveBeenCalled();
  });

  it.each(["0x0", "0garbage", " 0", "", null])("does not coerce malformed business code %j into success", async (code) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(jsonResponse(code, { active: true, today_checked_in: false }));
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves zero credit and reports delayed rewards", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(activity()).mockResolvedValueOnce(jsonResponse(0, { credit: 0, credit_delayed: true }));
    expect(await f.service.run(ID)).toMatchObject({ ok: true, reward: 0, message: "签到成功，积分将延迟到账" });
  });

  it.each(["status", "claim"])("does not mistake an HTTP failure's business code for success (%s)", async (phase) => {
    const f = fixture();
    if (phase === "claim") f.fetch.mockResolvedValueOnce(activity());
    f.fetch.mockResolvedValueOnce(jsonResponse(1001, {}, 500));
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error" });
    expect(f.state().lastSuccessDate).toBeUndefined();
  });

  it("handles invalid JSON as a sanitized error", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: vi.fn().mockRejectedValue(new SyntaxError("secret body")) });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error", message: "签到请求失败，请稍后重试" });
  });
});

describe("authentication, identity and proxy handling", () => {
  it.each(["status", "claim"])("classifies %s 401 plus successful summary as own_app without refresh", async (phase) => {
    const f = fixture({ state: { enabled: true } });
    if (phase === "claim") f.fetch.mockResolvedValueOnce(activity());
    f.fetch.mockResolvedValueOnce(jsonResponse(401, {}, 401)).mockResolvedValueOnce(jsonResponse(0));
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "own_app", message: expect.stringContaining("官方客户端") });
    expect(f.fetch.mock.calls.at(-1)[0]).toBe(`${config.origin}${config.summaryPath}`);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.updateConnection).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ terminalDate: "2026-10-22", retryAfter: 0 });
    expect(f.state().lastSuccessDate).toBeUndefined();
    expect(await f.service.run(ID, { automatic: true })).toMatchObject({ skipped: "cooldown" });
    expect(f.fetch).toHaveBeenCalledTimes(phase === "status" ? 2 : 3);
  });

  it("refreshes once after real status/summary authentication failure and retries with new credentials", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(jsonResponse(401, {}, 401)).mockResolvedValueOnce(jsonResponse(401, {}, 401));
    f.refresh.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
    expect(await f.service.run(ID)).toMatchObject({ ok: true, status: "success" });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.updateConnection).toHaveBeenCalledTimes(1);
    expect(f.connection()).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, expiresAt: "2026-10-22T05:00:00.000Z" });
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${config.origin}${config.statusPath}`, `${config.origin}${config.summaryPath}`,
      `${config.origin}${config.statusPath}`, `${config.origin}${config.claimPath}`,
    ]);
    expect(f.fetch.mock.calls.slice(2).every(([, options]) => options.headers.Authorization === "Bearer new-access")).toBe(true);
  });

  it("stops after a single unsuccessful refreshed status rather than looping", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(jsonResponse(401, {}, 401));
    f.refresh.mockResolvedValue({ accessToken: "new-access" });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error", message: expect.stringContaining("凭据已失效") });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.state().lastSuccessDate).toBeUndefined();
  });

  it.each([null, {}, { accessToken: "access-secret" }])("does not retry when refresh supplies no changed access token (%j)", async (tokens) => {
    const f = fixture();
    f.fetch.mockResolvedValue(jsonResponse(401, {}, 401));
    f.refresh.mockResolvedValue(tokens);
    expect(await f.service.run(ID)).toMatchObject({ ok: false, message: expect.stringContaining("凭据已失效") });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("reports failed claim authentication without trying to claim again", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(activity()).mockResolvedValueOnce(jsonResponse(401, {}, 401)).mockResolvedValueOnce(jsonResponse(401, {}, 401));
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error", message: expect.stringContaining("凭据已失效") });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a status 403", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(jsonResponse(403, {}, 403));
    expect(await f.service.run(ID)).toMatchObject({ ok: false, message: expect.stringContaining("凭据已失效") });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved account proxy to every request and to refresh", async () => {
    const providerSpecificData = {
      codebuddyUid: "uid-123", connectionProxyEnabled: true,
      connectionProxyUrl: " http://proxy.invalid:8888 ", connectionNoProxy: " localhost ",
    };
    const f = fixture({ connection: { providerSpecificData } });
    f.fetch.mockResolvedValueOnce(jsonResponse(401, {}, 401)).mockResolvedValueOnce(jsonResponse(401, {}, 401));
    f.refresh.mockResolvedValue({ accessToken: "new-access" });
    await f.service.run(ID);
    const proxy = { source: "connection", connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid:8888", connectionNoProxy: "localhost", strictProxy: false };
    expect(f.refresh).toHaveBeenCalledWith("refresh-secret", null, proxy);
    for (const [, , actualProxy] of f.fetch.mock.calls) expect(actualProxy).toEqual(proxy);
    expect(f.connection().refreshToken).toBe("refresh-secret");
  });

  it("proactively refreshes near-expiry credentials before contacting the activity endpoint", async () => {
    const f = fixture({ connection: { expiresAt: new Date(BASE_TIME + 299_999).toISOString() } });
    f.refresh.mockResolvedValue({ accessToken: "fresh-before-request", expiresIn: 3600 });
    expect((await f.service.run(ID)).status).toBe("success");
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh-before-request");
    expect(f.refresh.mock.invocationCallOrder[0]).toBeLessThan(f.fetch.mock.invocationCallOrder[0]);
  });

  it("does not refresh credentials exactly five minutes from expiry", async () => {
    const f = fixture({ connection: { expiresAt: new Date(BASE_TIME + 300_000).toISOString() } });
    await f.service.run(ID);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrent reauthorization with stale refreshed tokens", async () => {
    const f = fixture({ connection: { expiresAt: new Date(BASE_TIME - 1).toISOString() } });
    f.refresh.mockImplementationOnce(async () => {
      f.replaceConnection({ accessToken: "reauthorized-access", refreshToken: "reauthorized-refresh" });
      return { accessToken: "stale-refresh-access", refreshToken: "stale-refresh-token" };
    });
    await f.service.run(ID);
    expect(f.connection()).toMatchObject({ accessToken: "reauthorized-access", refreshToken: "reauthorized-refresh" });
    expect(f.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer reauthorized-access");
  });

  it("explains a missing UID without guessing JWT claims or contacting upstream", async () => {
    const f = fixture({ connection: { providerSpecificData: {}, accessToken: "eyJhbGciOiJub25lIn0.eyJ1aWQiOiJmYWtlIn0." } });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, status: "error", message: "无法获取账号 UID，请重新授权 CodeBuddy 账号" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.state().lastSuccessDate).toBeUndefined();
  });

  it("reports missing access credentials when no refresh token exists", async () => {
    const f = fixture({ connection: { accessToken: "", refreshToken: "" } });
    expect(await f.service.run(ID)).toMatchObject({ ok: false, message: expect.stringContaining("凭据已失效") });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });
});

describe("timeouts and public-state redaction", () => {
  it.each(["fetch", "refresh"])("sanitizes %s failures, releases the lease and starts cooldown", async (dependency) => {
    const f = fixture({ connection: dependency === "refresh" ? { expiresAt: new Date(BASE_TIME - 1).toISOString() } : {} });
    const secret = "access-secret refresh-secret uid-123 http://user:password@proxy.invalid raw-upstream-payload";
    f[dependency].mockRejectedValue(new DOMException(secret, "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await f.service.run(ID);
    expect(result).toMatchObject({ ok: false, status: "error", message: "签到请求失败，请稍后重试" });
    expect(f.state()).toMatchObject({ leaseId: null, leaseUntil: 0, retryAfter: BASE_TIME + config.retryMs });
    if (dependency === "fetch") expect(timeout).toHaveBeenCalledWith(config.timeoutMs);
    for (const value of [JSON.stringify(result), JSON.stringify(f.patches)]) {
      for (const sensitive of secret.split(" ")) expect(value).not.toContain(sensitive);
    }
    expect(f.state().lastSuccessDate).toBeUndefined();
  });

  it("allowlists public fields and never exposes credentials, leases, or internal timers", () => {
    expect(publicCheckinState({
      enabled: true, status: "success", message: "签到成功", lastAttemptAt: "attempt", lastSuccessDate: "2026-10-22", reward: 0,
      leaseId: "secret", leaseUntil: 123, retryAfter: 456, terminalDate: "private",
      accessToken: "secret", refreshToken: "secret", providerSpecificData: { codebuddyUid: "private" },
    })).toEqual({ enabled: true, status: "success", message: "签到成功", lastAttemptAt: "attempt", lastSuccessDate: "2026-10-22", reward: 0 });
    expect(publicCheckinState()).toEqual({ enabled: false, status: null, message: null, lastAttemptAt: null, lastSuccessDate: null, reward: null });
    expect(publicCheckinState({ enabled: "true", reward: Infinity })).toMatchObject({ enabled: false, reward: null });
  });
});
