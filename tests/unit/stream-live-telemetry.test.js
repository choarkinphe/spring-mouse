import { afterEach, describe, expect, it, vi } from "vitest";

const { update, finish } = vi.hoisted(() => ({ update: vi.fn(), finish: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  updatePendingRequestTokens: update, trackPendingRequest: finish, appendRequestLog: vi.fn(async () => {}),
}));
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it.each(["passthrough", "responses"])("streams %s progress using the request identity without changing final accounting", async (mode) => {
  vi.useFakeTimers();
  const completed = vi.fn();
  const stream = createSSEStream({
    mode: mode === "responses" ? "translate" : "passthrough",
    sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
    model: "model", provider: "codex", connectionId: "c1", apiKey: "test-key", requestId: "r1",
    inputTokenEstimate: 1000, completedContentMaxChars: 0, onStreamComplete: completed,
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const drained = (async () => { while (!(await reader.read()).done) {} })();
  const write = async (value) => {
    vi.setSystemTime(Date.now() + 300);
    await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  };
  expect(update).toHaveBeenLastCalledWith("model", "codex", "c1", "test-key", "r1", { inputTokens: 1000, outputTokens: 0, estimated: true });
  await write(mode === "responses" ? { type: "response.output_text.delta", delta: "abcdefgh" } : { choices: [{ delta: { content: "abcdefgh" } }] });
  expect(update.mock.lastCall[5]).toEqual({ inputTokens: 1000, outputTokens: 2, estimated: true });
  await write(mode === "responses" ? { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10 } } } : { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  expect(update.mock.lastCall[5]).toEqual({ inputTokens: 100, outputTokens: 10, estimated: false });
  await writer.close();
  await drained;
  expect(finish).toHaveBeenCalledWith("model", "codex", "c1", false, false, "test-key", "r1");
  expect(completed.mock.lastCall[1]).toMatchObject({ prompt_tokens: 100, completion_tokens: 10 });
});
