import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta")?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("streams parallel ordinary tools immediately while retaining Read repair", () => {
    const state = createState();
    const send = (tool_calls, finish_reason = null) => openaiToClaudeResponse({ choices: [{ delta: { tool_calls }, finish_reason }] }, state) || [];
    send([
      { index: 0, id: "read", function: { name: "proxy_Read" } },
      { index: 1, id: "write", function: { name: "proxy_Write" } },
      { index: 2, id: "custom", function: { name: "custom_tool" } },
    ]);
    const events = send([
      { index: 0, function: { arguments: '{"file_path":"a.js","limit":"5000"}' } },
      { index: 1, function: { arguments: '{"content":"part' } },
      { index: 2, function: { arguments: '{"q":"x"}' } },
    ]);
    expect(events.map(e => [e.index, e.delta.partial_json])).toEqual([[1, '{"content":"part'], [2, '{"q":"x"}']]);
    expect(state.toolArgBuffers.size).toBe(1);
    const final = send([{ index: 1, function: { arguments: ' two"}' } }], "tool_calls");
    expect(final.filter(e => e.delta?.type === "input_json_delta").map(e => [e.index, e.delta.partial_json])).toEqual([[1, ' two"}'], [0, '{"file_path":"a.js","limit":2000}']]);
    expect(state.toolArgBuffers.size).toBe(0);
    expect(final.filter(e => e.type === "content_block_stop")).toHaveLength(3);
  });
  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/file.js", offset: -5, limit: 999999999, pages: "" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });
});
