import { beforeEach, describe, expect, it, vi } from "vitest";

const saveRequestDetail = vi.fn(() => Promise.resolve());
const saveRequestUsage = vi.fn(() => Promise.resolve());

vi.mock("../../src/lib/usageDb.js", () => ({
  saveRequestDetail,
  saveRequestUsage,
  appendRequestLog: vi.fn(),
}));

describe("streaming routing metadata", () => {
  beforeEach(() => {
    saveRequestDetail.mockClear();
    saveRequestUsage.mockClear();
  });

  it("keeps the original and executed models when stream completion is persisted", async () => {
    const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      originalModel: "balanced",
      executedModel: "deepseek/deepseek-v4-flash",
      routing: {
        originalModel: "balanced",
        executedModel: "deepseek/deepseek-v4-flash",
      },
      connectionId: "conn-1",
      apiKey: "local-no-key",
      requestStartTime: Date.now() - 25,
      requestId: "stream-1",
      trafficRequestId: null,
      startedAt: new Date(Date.now() - 25).toISOString(),
      body: { model: "deepseek-v4-flash", messages: [] },
      stream: true,
      finalBody: { model: "deepseek/deepseek-v4-flash" },
      translatedBody: null,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        sourceIp: "127.0.0.1",
      },
      pxpipe: null,
      reqTag: "stream-test",
      log: null,
      observabilityEnabled: true,
      observabilityMaxJsonChars: 4096,
    });

    onStreamComplete(
      { content: "completed", thinking: null },
      { prompt_tokens: 12, completion_tokens: 4 },
      Date.now() - 10,
    );

    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      originalModel: "balanced",
      executedModel: "deepseek/deepseek-v4-flash",
      routing: {
        originalModel: "balanced",
        executedModel: "deepseek/deepseek-v4-flash",
      },
      requestId: "stream-1",
      status: "success",
    }));
    expect(saveRequestDetail).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "stream-1",
      originalModel: "balanced",
      executedModel: "deepseek/deepseek-v4-flash",
      routing: {
        originalModel: "balanced",
        executedModel: "deepseek/deepseek-v4-flash",
      },
      providerResponse: "completed",
      tokens: { prompt_tokens: 12, completion_tokens: 4 },
    }));
  });
});
