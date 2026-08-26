import { describe, expect, it } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

describe("stream completion memory bounds", () => {
  it("caps captured completion text while keeping usage estimation accurate", async () => {
    let completed = null;
    const body = { messages: [{ role: "user", content: "x".repeat(400) }] };
    const transform = createSSEStream({
      mode: "passthrough",
      provider: "openai",
      body,
      completedContentMaxChars: 4,
      inputTokenEstimate: 123,
      onStreamComplete: (content, usage) => { completed = { content, usage }; },
    });
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const encoder = new TextEncoder();

    const drain = (async () => {
      while (!(await reader.read()).done) {}
    })();

    await writer.write(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "abcdefgh" }, finish_reason: null }] })}\n\n`));
    await writer.close();
    await drain;

    expect(completed.content.content).toBe("abcd");
    expect(completed.content.truncated.content).toBe(true);
    expect(completed.usage.prompt_tokens).toBe(123);
  });
});
