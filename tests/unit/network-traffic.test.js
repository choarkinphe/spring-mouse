import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saveNetworkTraffic: vi.fn() }));

vi.mock("@/lib/db/repos/trafficRepo.js", () => ({ saveNetworkTraffic: mocks.saveNetworkTraffic }));
vi.mock("@/shared/utils/requestSource.js", () => ({
  getRequestSourceMeta: () => ({ appName: "test-client", sourceIp: "127.0.0.1" }),
}));

const { TRAFFIC_REQUEST_ID_HEADER, getTrafficRequestId, withNetworkTraffic } = await import("../../src/lib/networkTraffic.js");

describe("network traffic monitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveNetworkTraffic.mockResolvedValue(undefined);
  });

  it("counts UTF-8 request and streamed response payload bytes", async () => {
    const requestBody = JSON.stringify({ prompt: "你好" });
    let internalRequestId = null;
    const response = await withNetworkTraffic(
      new Request("http://localhost/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }),
      async (request) => {
        internalRequestId = request.headers.get(TRAFFIC_REQUEST_ID_HEADER);
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("第一段"));
            controller.enqueue(new TextEncoder().encode("/second"));
            controller.close();
          },
        }), { status: 200 });
      },
    );

    expect(await response.text()).toBe("第一段/second");
    expect(internalRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({
      requestId: internalRequestId,
      method: "POST",
      endpoint: "/api/v1/chat/completions",
      statusCode: 200,
      requestBytes: Buffer.byteLength(requestBody),
      responseBytes: Buffer.byteLength("第一段/second"),
      aborted: false,
    }));
  });

  it("counts the body even when content length is declared", async () => {
    const response = await withNetworkTraffic(
      new Request("http://localhost/api/v1/models"),
      async () => new Response("models", { headers: { "content-length": "6" } }),
    );

    expect(await response.text()).toBe("models");
    expect(mocks.saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/api/v1/models",
      requestBytes: 0,
      responseBytes: 6,
    }));
  });

  it("reads the internal traffic id from Request and plain header objects", () => {
    const request = new Request("http://localhost", { headers: { [TRAFFIC_REQUEST_ID_HEADER]: "traffic-1" } });
    expect(getTrafficRequestId(request)).toBe("traffic-1");
    expect(getTrafficRequestId({ [TRAFFIC_REQUEST_ID_HEADER]: "traffic-2" })).toBe("traffic-2");
  });
});
