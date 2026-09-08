import { beforeEach, describe, expect, it, vi } from "vitest";
import { Request as UndiciRequest, Response as UndiciResponse } from "undici";

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

  it("counts a chunked request without delaying the handler", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunked"));
        controller.close();
      },
    });
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: stream,
      duplex: "half",
    });
    const response = await withNetworkTraffic(request, async (monitoredRequest) => {
      expect(await monitoredRequest.text()).toBe("chunked");
      return new Response("ok");
    });

    expect(await response.text()).toBe("ok");
    expect(mocks.saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({ requestBytes: Buffer.byteLength("chunked") }));
  });

  it("supports a Request from another undici realm and preserves its body", async () => {
    const requestBody = JSON.stringify({ prompt: "跨 realm" });
    let internalRequestId = null;
    let internalBody = null;
    const response = await withNetworkTraffic(
      new UndiciRequest("http://localhost/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }),
      async (request) => {
        internalRequestId = getTrafficRequestId(request);
        internalBody = await request.text();
        return new Response("ok");
      },
    );

    expect(internalRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(internalBody).toBe(requestBody);
    expect(await response.text()).toBe("ok");
    expect(mocks.saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({
      requestId: internalRequestId,
      requestBytes: Buffer.byteLength(requestBody),
    }));
  });

  it("keeps attribution when the request constructor cannot clone", async () => {
    const request = new Request("http://localhost/v1/embeddings", { method: "POST", body: "{}" });
    Object.defineProperty(request, "constructor", { value: class UnsupportedRequest { constructor() { throw new Error("clone unsupported"); } } });
    let internalRequestId = null;

    const response = await withNetworkTraffic(request, async (monitoredRequest) => {
      internalRequestId = getTrafficRequestId(monitoredRequest);
      return new Response("ok");
    });

    expect(internalRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.text()).toBe("ok");
    expect(mocks.saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({ requestId: internalRequestId }));
  });

  it("meters a response from another realm without rejecting the business response", async () => {
    const response = await withNetworkTraffic(
      new Request("http://localhost/v1/models"),
      async () => new UndiciResponse("跨 realm response", { status: 201 }),
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("跨 realm response");
    expect(mocks.saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 201,
      responseBytes: Buffer.byteLength("跨 realm response"),
    }));
  });

  it("does not turn an empty response body into a monitoring failure", async () => {
    const response = await withNetworkTraffic(
      new Request("http://localhost/v1/models"),
      async () => new UndiciResponse(null, { status: 204 }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mocks.saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 204,
      responseBytes: 0,
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
