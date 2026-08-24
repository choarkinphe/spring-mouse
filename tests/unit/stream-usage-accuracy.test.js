import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { hasValuableContent } from "../../open-sse/utils/streamHelpers.js";

async function runPassthrough(events, body = { messages: [{ role: "user", content: "hello" }] }) {
  let completedUsage = null;
  const transform = createPassthroughStreamWithLogger(
    "openai",
    null,
    "gpt-test",
    null,
    body,
    (_content, usage) => { completedUsage = usage; },
  );
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let output = "";
  const reading = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
  })();

  await writer.write(encoder.encode(events.join("\n\n") + "\n\n"));
  await writer.close();
  await reading;
  return { output, usage: completedUsage };
}

function chunk(value) {
  return `data: ${JSON.stringify(value)}`;
}

describe("passthrough stream usage accuracy", () => {
  it("keeps the exact choices-empty include_usage chunk", async () => {
    const exact = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    const { output, usage } = await runPassthrough([
      chunk({ id: "chatcmpl-test", choices: [{ delta: { content: "ok" }, finish_reason: null }] }),
      chunk({ id: "chatcmpl-test", choices: [{ delta: {}, finish_reason: "stop" }] }),
      chunk({ id: "chatcmpl-test", choices: [], usage: exact }),
      "data: [DONE]",
    ]);

    expect(usage).toMatchObject(exact);
    expect(usage.estimated).not.toBe(true);
    expect(output).toContain('"choices":[],"usage":{"prompt_tokens":12');
  });

  it("uses an unpadded estimate only when the provider sends no usage", async () => {
    const { usage } = await runPassthrough([
      chunk({ id: "chatcmpl-test", choices: [{ delta: { content: "short answer" }, finish_reason: null }] }),
      chunk({ id: "chatcmpl-test", choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]",
    ]);

    expect(usage.estimated).toBe(true);
    expect(usage.prompt_tokens).toBeLessThan(100);
    expect(usage.completion_tokens).toBe(3);
  });
});


describe("valuable stream events", () => {
  it("keeps usage-only OpenAI chunks and same-format Claude events", () => {
    expect(hasValuableContent({ choices: [], usage: { prompt_tokens: 1 } }, FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent({ type: "message_start", message: { usage: { input_tokens: 1 } } }, FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent({ choices: [] }, FORMATS.OPENAI)).toBe(false);
  });
});
