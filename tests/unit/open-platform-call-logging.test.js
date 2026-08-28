import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasTrustedPeerHeaders: vi.fn(),
  normalizeIp: vi.fn((value) => value),
  recordOpenPlatformApiCall: vi.fn(),
}));

vi.mock("@/lib/auth/trustedPeer", () => ({
  hasTrustedPeerHeaders: mocks.hasTrustedPeerHeaders,
}));

vi.mock("@/lib/auth/ipAccess", () => ({
  normalizeIp: mocks.normalizeIp,
}));

vi.mock("@/lib/localDb", () => ({
  recordOpenPlatformApiCall: mocks.recordOpenPlatformApiCall,
}));

const { recordOpenPlatformRequest } = await import("@/lib/openPlatform/callLogging.js");

function makeRequest(headers = {}) {
  return new Request("http://localhost/api/open/v1/usage/report?userId=user-a", {
    method: "GET",
    headers,
  });
}

describe("open platform request logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedPeerHeaders.mockReturnValue(false);
    mocks.recordOpenPlatformApiCall.mockResolvedValue({ id: 1 });
  });

  it("records the normalized public path and request metadata", async () => {
    mocks.hasTrustedPeerHeaders.mockReturnValue(true);
    const request = makeRequest({
      "x-sm-real-ip": "203.0.113.8",
      "user-agent": "external-report-client/1.0",
    });
    const response = new Response("ok", { status: 200 });

    await recordOpenPlatformRequest({
      credential: { id: "key-a", name: "BI", keyPrefix: "smop_example" },
      request,
      response,
      startedAt: Date.now() - 15,
      subjectUserId: "user-a",
    });

    expect(mocks.recordOpenPlatformApiCall).toHaveBeenCalledWith(expect.objectContaining({
      apiKeyId: "key-a",
      keyName: "BI",
      keyPrefix: "smop_example",
      method: "GET",
      path: "/open/v1/usage/report",
      statusCode: 200,
      sourceIp: "203.0.113.8",
      userAgent: "external-report-client/1.0",
      subjectUserId: "user-a",
    }));
    expect(mocks.recordOpenPlatformApiCall.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not trust forwarded IP headers without a trusted peer marker", async () => {
    await recordOpenPlatformRequest({
      credential: { id: "key-a", name: "BI", keyPrefix: "smop_example" },
      request: makeRequest({ "x-sm-real-ip": "203.0.113.8" }),
      response: new Response(null, { status: 404 }),
      startedAt: Date.now(),
    });

    expect(mocks.recordOpenPlatformApiCall).toHaveBeenCalledWith(expect.objectContaining({ sourceIp: null, statusCode: 404 }));
  });

  it("skips unauthenticated calls and never changes the response", async () => {
    const response = new Response(null, { status: 401 });
    const returned = await recordOpenPlatformRequest({
      credential: null,
      request: makeRequest(),
      response,
      startedAt: Date.now(),
    });

    expect(returned).toBe(response);
    expect(mocks.recordOpenPlatformApiCall).not.toHaveBeenCalled();
  });

  it("does not fail the API response when persistence fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.recordOpenPlatformApiCall.mockRejectedValueOnce(new Error("disk full"));
    const response = new Response("ok", { status: 200 });

    const returned = await recordOpenPlatformRequest({
      credential: { id: "key-a", name: "BI", keyPrefix: "smop_example" },
      request: makeRequest(),
      response,
      startedAt: Date.now(),
    });

    expect(returned).toBe(response);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
