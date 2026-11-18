/**
 * A stream that answered part of a turn and then went quiet is cut by the
 * client-side stall watchdog (utils/streamHandler.js). Production showed three
 * such Codex turns on 0.4.347, each recorded only as the generic "Request
 * failed; see the request detail…" label. This drives the real watchdog through
 * handleChatCore and pins the specific, text-free label the usage row gets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.STREAM_VISIBLE_STALL_TIMEOUT_MS = "50";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ execute }) }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}), trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
}));

const { saveRequestUsage } = await import("@/lib/usageDb.js");
await import("../translator/registerAll.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { summarizeUsageError } = await import("../../src/shared/utils/usageError.js");

beforeEach(() => vi.clearAllMocks());

describe("a stalled stream is labelled as a stall", () => {
  it("records the watchdog's stall code, which maps to a specific label", async () => {
    let upstream;
    execute.mockResolvedValueOnce({
      responseFormat: "openai",
      response: new Response(new ReadableStream({ start(c) { upstream = c; } }), { headers: { "content-type": "text/event-stream" } }),
    });
    const body = { model: "gpt-4.1", messages: [{ role: "user", content: "synthetic" }], stream: true };
    const result = await handleChatCore({
      body, modelInfo: { provider: "openai", model: "gpt-4.1" }, credentials: {}, requestId: "stall-label",
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "text/event-stream" } },
      sourceFormatOverride: "openai", log: { debug() {}, info() {}, warn() {}, error() {}, line() {}, errorLine() {} },
      requestLogFileDumpsEnabled: false,
    });
    const reader = result.response.body.getReader();
    // Some visible output, then the upstream goes silent without a terminal.
    upstream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    await reader.read();
    await vi.waitFor(() => expect(saveRequestUsage).toHaveBeenCalledOnce(), { timeout: 4000, interval: 50 });
    await reader.cancel().catch(() => {});

    const row = saveRequestUsage.mock.calls[0][0];
    expect(row.status).toBe("error");
    expect(row.error).toContain("UPSTREAM_VISIBLE_STALL:upstream_idle_client_silent");
    expect(summarizeUsageError(row.error, row.status)).toBe("Upstream stopped mid-answer and the stream stalled");
  });
});

describe("stream failure labels", () => {
  it.each([
    ["Stream failed (stream_error; UPSTREAM_VISIBLE_STALL:upstream_idle_client_silent)", "Upstream stopped mid-answer and the stream stalled"],
    ["Stream failed (stream_error; UPSTREAM_VISIBLE_STALL:upstream_active_client_silent)", "Upstream kept sending but nothing reached the client (stalled)"],
    ["Stream failed (stream_error; UPSTREAM_STALL)", "Upstream stream went silent and was stopped"],
    ["Stream ended failed (stream_error)", "Upstream stream failed mid-answer"],
  ])("%s", (text, label) => {
    expect(summarizeUsageError(text, "error")).toBe(label);
  });

  it("still reports a plain timeout as a timeout", () => {
    expect(summarizeUsageError("Request timed out after 30s", "error")).toBe("Request timed out");
  });
});
