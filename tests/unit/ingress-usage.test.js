import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saveRequestUsage: vi.fn() }));

vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

const { recordIngressUsage } = await import("../../src/sse/services/ingressUsage.js");

describe("ingress usage attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SPRING_MOUSE_PEER_TOKEN = "peer-token";
    mocks.saveRequestUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.SPRING_MOUSE_PEER_TOKEN;
  });

  it("persists the raw ingress key for id resolution and request source", async () => {
    const request = new Request("http://localhost:8008/v1/audio/speech", {
      headers: {
        authorization: "Bearer sk-source-key",
        "user-agent": "test-client",
        "x-sm-peer-token": "peer-token",
        "x-sm-real-ip": "127.0.0.1",
        "x-sm-traffic-request-id": "traffic-request-1",
      },
    });

    await recordIngressUsage(request, "sk-source-key", { model: "openai/tts-1" });

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-source-key",
      model: "openai/tts-1",
      endpoint: "/v1/audio/speech",
      trafficRequestId: "traffic-request-1",
      sourceIp: "127.0.0.1",
      status: "success",
    }));
  });

  it("marks a non-2xx response as an error", async () => {
    const request = new Request("http://localhost:8008/v1/videos/abc");
    const response = Response.json({}, { status: 502 });

    await recordIngressUsage(request, null, { model: "abc", response });

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: null,
      model: "abc",
      status: "error",
    }));
  });
});
