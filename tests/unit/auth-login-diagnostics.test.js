import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { classifyLoginError, sanitizeLoginDiagnostic } from "../../src/lib/auth/loginDiagnostics.js";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), cookies: vi.fn(), compare: vi.fn(),
  clearDashboardMfaChallengeCookie: vi.fn(), setDashboardAuthCookie: vi.fn(), setDashboardMfaChallengeCookie: vi.fn(),
  getClientIp: vi.fn(), checkLock: vi.fn(), recordSuccess: vi.fn(), recordFail: vi.fn(), isLocalRequest: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  clearDashboardMfaChallengeCookie: mocks.clearDashboardMfaChallengeCookie,
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
  setDashboardMfaChallengeCookie: mocks.setDashboardMfaChallengeCookie,
}));
vi.mock("@/lib/auth/loginLimiter", () => ({
  getClientIp: mocks.getClientIp, checkLock: mocks.checkLock,
  recordSuccess: mocks.recordSuccess, recordFail: mocks.recordFail,
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));
const { POST } = await import("../../src/app/api/auth/login/route.js");
const secret = "password-cookie-jwt-request-SHOULD-NOT-APPEAR";
const request = () => new Request("http://localhost/api/auth/login", { method: "POST", body: JSON.stringify({ password: secret }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INITIAL_PASSWORD", secret);
  mocks.getSettings.mockResolvedValue({});
  mocks.checkLock.mockReturnValue({ locked: false });
  mocks.recordFail.mockReturnValue({ remainingBeforeLock: 4 });
  mocks.cookies.mockResolvedValue({});
  mocks.isLocalRequest.mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("login failure diagnostics", () => {
  it.each([
    ["getClientIp", "rate-limit"], ["checkLock", "rate-limit"], ["getSettings", "settings"],
    ["recordSuccess", "record-success"], ["cookies", "cookie-store"],
    ["clearDashboardMfaChallengeCookie", "clear-mfa-cookie"], ["setDashboardAuthCookie", "auth-cookie"],
  ])("records only safe labels when %s throws, without retry", async (fn, stage) => {
    const error = Object.assign(new TypeError(secret), { code: secret, cause: { password: secret } });
    mocks[fn].mockImplementation(() => { throw error; });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    const log = console.error.mock.calls[0][0];
    expect(log).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.parse(log)).toEqual({ event: "auth.login.failure", errorId: body.errorId, stage, name: "TypeError", code: "unknown", category: "type-error" });
    expect(body.error).toBe("Login failed");
    expect(body.errorId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(mocks[fn]).toHaveBeenCalledTimes(1);
  });

  it("suppresses malformed-body logs without exposing the input", async () => {
    const response = await POST(new Request("http://localhost/api/auth/login", { method: "POST", body: secret }));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(console.error).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(classifyLoginError(new SyntaxError(secret), "parse-body").category).toBe("request-json");
  });

  it("distinguishes password verification from settings errors", async () => {
    mocks.getSettings.mockResolvedValue({ password: "hash" });
    mocks.compare.mockRejectedValue(new TypeError(secret));
    expect((await POST(request())).status).toBe(500);
    expect(JSON.parse(console.error.mock.calls[0][0]).stage).toBe("verify-password");
  });

  it("identifies MFA issuance failures", async () => {
    mocks.getSettings.mockResolvedValue({ totpEnabled: true, totpSecretEncrypted: secret });
    mocks.setDashboardMfaChallengeCookie.mockRejectedValue(new Error(secret));
    expect((await POST(request())).status).toBe(500);
    expect(JSON.parse(console.error.mock.calls[0][0]).stage).toBe("mfa-cookie");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("identifies local-policy failures without issuing a session", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "");
    mocks.isLocalRequest.mockImplementation(() => { throw new Error(secret); });
    const response = await POST(new Request("http://localhost/api/auth/login", { method: "POST", body: JSON.stringify({ password: "123456" }) }));
    expect(response.status).toBe(500);
    expect(JSON.parse(console.error.mock.calls[0][0]).stage).toBe("local-policy");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("identifies failure-counter errors without retrying", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "different");
    mocks.recordFail.mockImplementation(() => { throw new Error(secret); });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(JSON.parse(console.error.mock.calls[0][0]).stage).toBe("record-failure");
    expect(mocks.recordFail).toHaveBeenCalledTimes(1);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("does not log successful login", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, mustChangePassword: false, requiresTotp: false });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("preserves the remote default-password refusal without issuing a cookie", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "");
    mocks.isLocalRequest.mockReturnValue(false);
    const response = await POST(new Request("http://localhost/api/auth/login", { method: "POST", body: JSON.stringify({ password: "123456" }) }));
    expect(response.status).toBe(403);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("preserves successful MFA challenge issuance", async () => {
    mocks.getSettings.mockResolvedValue({ totpEnabled: true, totpSecretEncrypted: secret });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).requiresTotp).toBe(true);
    expect(mocks.setDashboardMfaChallengeCookie).toHaveBeenCalledTimes(1);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("preserves invalid-password and lockout statuses", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "different");
    expect((await POST(request())).status).toBe(401);
    mocks.checkLock.mockReturnValue({ locked: true, retryAfter: 10 });
    expect((await POST(request())).status).toBe(429);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([[5, "sqlite-busy"], [517, "sqlite-busy"], [6, "sqlite-locked"], [262, "sqlite-locked"], [1, "sqlite-error"]])("classifies Node SQLite error %s without exporting its details", (errcode, category) => {
    const result = classifyLoginError({ code: "ERR_SQLITE_ERROR", errcode, message: secret }, "settings");
    expect(result).toEqual({ name: "unknown", code: "ERR_SQLITE_ERROR", category });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not classify arbitrary settings errors as database locks", () => {
    expect(classifyLoginError(new Error(secret), "settings").category).toBe("unknown");
    expect(classifyLoginError({ code: "SQLITE_BUSY", message: secret }, "settings").category).toBe("sqlite-busy");
    expect(classifyLoginError({ code: "EACCES", message: secret }, "settings").category).toBe("filesystem");
    expect(sanitizeLoginDiagnostic({ stage: secret, name: secret, code: secret, category: secret, errorId: secret })).toEqual({ event: "auth.login.failure", stage: "unknown", name: "unknown", code: "unknown", category: "unknown", errorId: "unavailable" });
  });
});
