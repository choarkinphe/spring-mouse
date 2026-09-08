import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/config/runtimeConfig.js", async (importOriginal) => ({
  ...(await importOriginal()),
  NON_STREAM_RESPONSE_TIMEOUT_MS: 20,
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((value) => value),
  extractRequestConfig: vi.fn(() => ({})),
  extractUsageFromResponse: vi.fn(() => null),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => "done"),
}));

import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

describe("non-streaming upstream body deadline", () => {
  it("returns 504 and aborts upstream when headers arrive but JSON never completes", async () => {
    const upstream = new AbortController();
    const abort = vi.fn((reason) => upstream.abort(reason));
    const trackDone = vi.fn();
    const appendLog = vi.fn();

    const result = await handleNonStreamingResponse({
      providerResponse: {
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => new Promise(() => {}),
      },
      provider: "test-provider",
      model: "test-model",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { model: "test-model", messages: [] },
      stream: false,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      requestId: "request-1",
      startedAt: new Date().toISOString(),
      connectionId: "connection-1",
      clientRawRequest: {},
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
      trackDone,
      appendLog,
      streamController: { signal: upstream.signal, abort },
      log: {},
    });

    expect(result).toMatchObject({ success: false, status: 504 });
    expect(abort).toHaveBeenCalledWith("response_body_timeout");
    expect(trackDone).toHaveBeenCalledTimes(1);
    expect(appendLog).toHaveBeenCalledWith({ status: "FAILED 504" });
  });
});
