import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnectionById: vi.fn() }));
vi.mock("@/lib/db/repos/checkinRepo.js", () => ({ getCheckinState: vi.fn() }));
vi.mock("@/lib/services/codebuddyCheckin.js", () => ({
  publicCheckinState: vi.fn((state) => ({ enabled: state.enabled === true })),
  runCodeBuddyCheckin: vi.fn(),
  setCodeBuddyCheckinEnabled: vi.fn(),
}));
const { getProviderConnectionById } = await import("@/lib/db/repos/connectionsRepo.js");
const { getCheckinState } = await import("@/lib/db/repos/checkinRepo.js");
const { runCodeBuddyCheckin, setCodeBuddyCheckinEnabled } = await import("@/lib/services/codebuddyCheckin.js");
const { GET, POST, PATCH } = await import("../../src/app/api/providers/[id]/checkin/route.js");
const context = () => ({ params: Promise.resolve({ id: "account" }) });
const req = (body) => new Request("http://localhost/api/providers/account/checkin", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  getProviderConnectionById.mockResolvedValue({ id: "account", provider: "codebuddy-cn", authType: "oauth" });
  getCheckinState.mockResolvedValue({ enabled: false, leaseId: "internal" });
});

describe("CodeBuddy checkin management route", () => {
  it("reads a sanitized state", async () => {
    const response = await GET(null, context());
    expect(await response.json()).toEqual({ checkin: { enabled: false } });
  });
  it("rejects missing and unsupported connections", async () => {
    getProviderConnectionById.mockResolvedValueOnce(null);
    expect((await GET(null, context())).status).toBe(404);
    getProviderConnectionById.mockResolvedValueOnce({ provider: "codebuddy-intl", authType: "oauth" });
    expect((await PATCH(req({ enabled: true }), context())).status).toBe(400);
    expect(setCodeBuddyCheckinEnabled).not.toHaveBeenCalled();
  });
  it.each([{}, { enabled: "true" }, { enabled: 1 }, null])("rejects invalid switches %j", async (body) => {
    expect((await PATCH(req(body), context())).status).toBe(400);
    expect(setCodeBuddyCheckinEnabled).not.toHaveBeenCalled();
  });
  it("saves only the boolean switch, not client-supplied results", async () => {
    setCodeBuddyCheckinEnabled.mockResolvedValue({ enabled: true });
    const response = await PATCH(req({ enabled: true, lastSuccessDate: "2099-01-01" }), context());
    expect(response.status).toBe(200);
    expect(setCodeBuddyCheckinEnabled).toHaveBeenCalledExactlyOnceWith("account", true);
  });
  it("returns a failed attempt with state for the UI", async () => {
    runCodeBuddyCheckin.mockResolvedValue({ ok: false, message: "签到请求失败，请稍后重试", checkin: { enabled: true, status: "error" } });
    const response = await POST(null, context());
    expect(response.status).toBe(502);
    expect((await response.json()).checkin.status).toBe("error");
  });
  it("does not expose thrown credential errors", async () => {
    runCodeBuddyCheckin.mockRejectedValue(new Error("secret-token-in-error"));
    const response = await POST(null, context());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-token");
  });
});
