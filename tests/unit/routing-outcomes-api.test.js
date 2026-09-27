import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    headers: init?.headers || {},
  })),
  cookies: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  getRoutingOutcomes: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: mocks.getDashboardAuthSession }));
vi.mock("@/lib/db/repos/routingTelemetryRepo.js", () => ({ getRoutingOutcomes: mocks.getRoutingOutcomes }));

const { GET } = await import("../../src/app/api/usage/routing-outcomes/route.js");

function request(search = "") {
  return { url: `http://localhost/api/usage/routing-outcomes${search}` };
}

function expectNoStore(response) {
  expect(response.headers["Cache-Control"]).toMatch(/no-store/);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: "session-token" })) });
  mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
  mocks.getRoutingOutcomes.mockResolvedValue({ requests: { total: 1 } });
});

describe("GET /api/usage/routing-outcomes", () => {
  it("requires an explicitly authenticated dashboard session, even with scope filters", async () => {
    mocks.getDashboardAuthSession.mockResolvedValueOnce({ authenticated: false });
    const falseSession = await GET(request("?scope=dashboard&apiKeyId=bypass"));
    expect(falseSession.status).toBe(401);
    expectNoStore(falseSession);
    expect(mocks.getRoutingOutcomes).not.toHaveBeenCalled();

    mocks.getDashboardAuthSession.mockResolvedValueOnce({});
    const missingClaim = await GET(request());
    expect(missingClaim.status).toBe(401);
    expectNoStore(missingClaim);
  });

  it("reads an explicit ISO range after authenticating, without forwarding scope bypass", async () => {
    const response = await GET(request("?startDate=2026-01-01&endDate=2026-01-02&scope=dashboard&apiKeyId=key-1"));
    expect(response.status).toBe(200);
    expect(response.body.requests.total).toBe(1);
    expect(mocks.getDashboardAuthSession).toHaveBeenCalledWith("session-token");
    expect(mocks.getRoutingOutcomes).toHaveBeenCalledWith({ startDate: "2026-01-01", endDate: "2026-01-02" });
    expectNoStore(response);
  });

  it("returns no-store on invalid range and internal failure", async () => {
    mocks.getRoutingOutcomes.mockRejectedValueOnce(new RangeError("Invalid date range"));
    const invalid = await GET(request("?startDate=2026-02-30"));
    expect(invalid.status).toBe(400);
    expectNoStore(invalid);

    mocks.getRoutingOutcomes.mockRejectedValueOnce(new Error("private database failure"));
    const error = await GET(request());
    expect(error.status).toBe(500);
    expect(error.body).toEqual({ error: "Failed to fetch routing outcomes" });
    expectNoStore(error);
  });

  it("fails closed when cookies or session verification throws", async () => {
    mocks.cookies.mockRejectedValueOnce(new Error("cookie store unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mocks.getRoutingOutcomes).not.toHaveBeenCalled();
    expectNoStore(response);
  });
});
