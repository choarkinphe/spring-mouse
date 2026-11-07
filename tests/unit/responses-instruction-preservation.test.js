import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const model = "gpt-5.4";
describe("Chat to Responses instruction preservation", () => {
  it("retains multiple and interleaved system/developer instructions in order through Codex", () => {
    const body = { messages: [
      { role: "system", content: "first rule" },
      { role: "developer", content: [{ type: "text", text: "second rule" }, { type: "text", text: "third rule" }] },
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer" },
      { role: "system", content: "later rule" },
      { role: "user", content: "next" },
    ] };
    const original = structuredClone(body);
    const translated = translateRequest("openai", "openai-responses", model, structuredClone(body), true, {}, "codex");
    const output = new CodexExecutor().transformRequest(model, translated, true, { connectionId: "fixture" });
    expect(output.instructions).toBe("first rule");
    expect(output.input.map(item => item.role)).toEqual(["developer", "user", "assistant", "developer", "user"]);
    expect(output.input[0].content).toEqual([{ type: "input_text", text: "second rule" }, { type: "input_text", text: "third rule" }]);
    expect(output.input[3].content).toEqual([{ type: "input_text", text: "later rule" }]);
    expect(body).toEqual(original);
  });

  it("does not hoist a mid-conversation first instruction above prior messages", () => {
    const output = openaiToOpenAIResponsesRequest(model, { messages: [
      { role: "user", content: "hello" }, { role: "system", content: "later rule" },
    ] }, true, {});
    expect(output.instructions).toBe("");
    expect(output.input.map(item => item.role)).toEqual(["user", "developer"]);
  });

  it("does not silently discard non-text instructions", () => {
    expect(() => openaiToOpenAIResponsesRequest(model, { messages: [
      { role: "system", content: [{ type: "image_url", image_url: { url: "https://invalid.test/image" } }] },
    ] }, true, {})).toThrow("must contain text blocks");
  });

  it("retains first array instructions and leaves native Responses unchanged", () => {
    const output = openaiToOpenAIResponsesRequest(model, { messages: [
      { role: "system", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      { role: "user", content: "hello" },
    ] }, true, {});
    expect(output.instructions).toBe("one\ntwo");
    const native = { input: [{ role: "developer", content: "native rule" }], instructions: "native", store: false };
    expect(openaiToOpenAIResponsesRequest(model, native, true, {})).toMatchObject(native);
  });
});
