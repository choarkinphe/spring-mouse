import {beforeEach, describe, expect, it, vi} from "vitest";
const mocks = vi.hoisted(() => ({read:vi.fn()}));
vi.mock("@/lib/usageDb", () => ({getRequestDetailByRequestId:mocks.read}));
const {GET} = await import("../../src/app/api/usage/request-details/conversation/route.js");
const request = () => new Request("http://localhost/api/usage/request-details/conversation?requestId=example");
beforeEach(() => vi.clearAllMocks());
describe("dashboard conversation latency", () => {
  it("exposes safe timings even when the conversation body is unavailable", async () => {
    mocks.read.mockResolvedValue({latency:{scope:"request",ttft:1234,total:2000,queueWaitMs:20,preDispatchMs:30,weight:2,private:"must not leak"}});
    const data = await (await GET(request())).json();
    expect(data.conversation).toBeNull();
    expect(data.latency).toEqual({scope:"request",ttft:1234,total:2000,queueWaitMs:20,preDispatchMs:30,weight:2});
  });
  it("marks historical timing separately and keeps unknown values absent", async () => {
    mocks.read.mockResolvedValue({latency:{ttft:0,total:100,queueWaitMs:null,preDispatchMs:-1}});
    const data = await (await GET(request())).json();
    expect(data.latency).toEqual({scope:"attempt",ttft:0,total:100});
  });
  it("does not synthesize timing for a missing detail", async () => {
    mocks.read.mockResolvedValue(null);
    const data = await (await GET(request())).json();
    expect(data.latency).toBeUndefined();
  });
});

it("exposes only numeric phase timings, excluding payload diagnostics", async () => {
  mocks.read.mockResolvedValue({ latency: { scope: "request", upstreamHeadersMs: 12, firstOutputWaitMs: 100, streamScanMs: 150, postOutputBufferMs: 50, executorTotalMs: 180, upstreamAttempts: 2, scanDiagnostics: { body: "secret" } } });
  const data = await (await GET(request())).json();
  expect(data.latency).toEqual({ scope: "request", upstreamHeadersMs: 12, firstOutputWaitMs: 100, streamScanMs: 150, postOutputBufferMs: 50, executorTotalMs: 180, upstreamAttempts: 2 });
});
