import { describe, expect, it } from "vitest";
import { compactJsonField, extractUserPrompt, summarizeChatRequest } from "@/lib/requestDetailCompact.js";

/**
 * When a request body is too large to store, the operator still needs to answer
 * "what did the user send this turn". A 200-char slice of the raw JSON does not
 * — the messages array is usually past the truncation point, so the preview
 * shows request metadata and none of the conversation. These tests pin the
 * digest that replaces it.
 */

describe("summarizeChatRequest", () => {
  it("keeps each message's role and text", () => {
    const summary = summarizeChatRequest({
      model: "gpt-5.6-sol",
      stream: true,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
      ],
    });

    expect(summary.messageCount).toBe(3);
    expect(summary.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(summary.messages[1].text).toBe("What is 2+2?");
    expect(summary.model).toBe("gpt-5.6-sol");
    expect(summary.stream).toBe(true);
  });

  it("bounds each message's text and flags the truncation", () => {
    const summary = summarizeChatRequest({ messages: [{ role: "user", content: "y".repeat(5000) }] });
    expect(summary.messages[0].chars).toBe(5000);
    expect(summary.messages[0].text.length).toBe(400);
    expect(summary.messages[0].truncated).toBe(true);
  });

  it("caps the number of messages and reports how many were dropped", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const summary = summarizeChatRequest({ messages });
    expect(summary.messageCount).toBe(30);
    expect(summary.messages.length).toBe(12);
    expect(summary.omittedMessages).toBe(18);
  });

  it("keeps text out of multimodal content and names the other parts", () => {
    const summary = summarizeChatRequest({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    });
    expect(summary.messages[0].text).toContain("describe this");
    expect(summary.messages[0].text).toContain("[image_url]");
    expect(summary.messages[0].parts).toBe(2);
    // The base64 payload must not bloat the digest.
    expect(summary.messages[0].text).not.toContain("base64");
  });

  it("reports tool calls and tool count without storing their bodies", () => {
    const summary = summarizeChatRequest({
      tools: [{ type: "function" }, { type: "function" }],
      messages: [{ role: "assistant", content: "ok", tool_calls: [{ id: "1" }, { id: "2" }] }],
    });
    expect(summary.toolCount).toBe(2);
    expect(summary.messages[0].toolCalls).toBe(2);
  });

  it("returns null when there is no conversation to summarize", () => {
    expect(summarizeChatRequest({ model: "x" })).toBe(null);
    expect(summarizeChatRequest({ messages: [] })).toBe(null);
    expect(summarizeChatRequest(null)).toBe(null);
    expect(summarizeChatRequest("nope")).toBe(null);
  });

  it("stays bounded even for a pathological conversation", () => {
    const messages = Array.from({ length: 200 }, () => ({ role: "user", content: "z".repeat(10_000) }));
    const summary = summarizeChatRequest({ messages });
    expect(JSON.stringify(summary).length).toBeLessThan(20_000);
  });
});

describe("compactJsonField summary integration", () => {
  it("attaches the digest when a chat body is truncated", () => {
    const big = "x".repeat(200_000);
    const compacted = compactJsonField({
      model: "gpt-5.6-sol",
      messages: [
        { role: "system", content: big },
        { role: "user", content: "the actual question" },
      ],
    }, 1024);

    expect(compacted._truncated).toBe(true);
    expect(compacted._summary.messageCount).toBe(2);
    expect(compacted._summary.messages[1].text).toBe("the actual question");
    // The old preview is kept alongside, so nothing that read it breaks.
    expect(typeof compacted._preview).toBe("string");
  });

  it("does not attach a digest to a non-chat payload", () => {
    const compacted = compactJsonField({ some: "x".repeat(5000) }, 1024);
    expect(compacted._truncated).toBe(true);
    expect(compacted._summary).toBeUndefined();
  });
});

/**
 * The usage table's "用户提问" column shows what the USER sent, not the whole
 * conversation — mirroring the provider export's "User Prompt". It is the last
 * user turn's text only: no roles, no assistant replies, no tool metadata.
 */
describe("extractUserPrompt", () => {
  it("returns only the last user message, ignoring system and assistant turns", () => {
    const prompt = extractUserPrompt({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "first question" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: "the actual question" },
      ],
    });
    expect(prompt).toBe("the actual question");
  });

  it("keeps the human text from a multimodal turn, without the base64 payload", () => {
    const prompt = extractUserPrompt({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    });
    expect(prompt).toBe("describe this");
    // The attachment placeholder is harness scaffolding, not the human's words.
    expect(prompt).not.toContain("[image_url]");
    expect(prompt).not.toContain("base64");
  });

  it("caps the prompt length", () => {
    const prompt = extractUserPrompt({ messages: [{ role: "user", content: "y".repeat(5000) }] });
    expect(prompt.length).toBe(2048);
    // Never split a surrogate pair.
    const emoji = extractUserPrompt({ messages: [{ role: "user", content: "🙂".repeat(3000) }] });
    expect(emoji).not.toContain("�");
  });

  it("returns empty when there is no user turn", () => {
    expect(extractUserPrompt({ messages: [{ role: "assistant", content: "hi" }] })).toBe("");
    expect(extractUserPrompt({ messages: [] })).toBe("");
    expect(extractUserPrompt(null)).toBe("");
    expect(extractUserPrompt("nope")).toBe("");
  });

  it("reads a compacted body's digest, which is what production mostly stores", () => {
    // compactJsonField replaces an oversized body with `_summary`, whose messages
    // carry `text` rather than `content`. Most prod rows look like this, so
    // reading only `messages` would return "" for the majority of traffic.
    const compacted = compactJsonField({
      model: "gpt-5.6-sol",
      messages: [
        { role: "system", content: "x".repeat(200_000) },
        { role: "user", content: "the real question" },
      ],
    }, 1024);

    expect(compacted._truncated).toBe(true);
    expect(extractUserPrompt(compacted)).toBe("the real question");
  });

  it("skips relayed tool results and finds the human turn behind them", () => {
    // Agent clients send tool output as `role: "user"`, so the newest user turn
    // is usually NOT the question. The provider export never shows these.
    const prompt = extractUserPrompt({
      messages: [
        { role: "user", content: "please fix the bug" },
        { role: "assistant", content: "reading the file" },
        { role: "user", content: "[tool_result]\n[tool_result]" },
      ],
    });
    expect(prompt).toBe("please fix the bug");
  });

  it("skips an attachment-only turn the same way", () => {
    expect(extractUserPrompt({
      messages: [
        { role: "user", content: "look at this" },
        { role: "user", content: "Attached image(s) from tool result:" },
      ],
    })).toBe("look at this");
  });

  it("skips a tool relay that carries injected instructions after the marker", () => {
    // Observed in production: a tool_result turn with harness instructions
    // appended. Those are not the human's words, so the turn is skipped and the
    // walk-back finds the real prompt.
    expect(extractUserPrompt({
      messages: [
        { role: "user", content: "what does this function do?" },
        { role: "user", content: "[tool_result]\nCRITICAL: Respond with TEXT ONLY. Do NOT call any tools." },
      ],
    })).toBe("what does this function do?");
  });

  it("keeps the human text the client appends to an interrupted turn", () => {
    // Production shape: the tool turn is interrupted and the user's next message
    // is appended to that SAME turn. Everything after the marker is the human.
    expect(extractUserPrompt({
      messages: [
        { role: "user", content: "earlier question" },
        { role: "user", content: "[tool_result]\n[tool_result]\n[Request interrupted by user]\n\n清空历史测试数据并重跑全流程" },
      ],
    })).toBe("清空历史测试数据并重跑全流程");
  });

  it("strips harness scaffolding that arrives as a user turn", () => {
    // The column was showing these in production: a CLAUDE.md dump wrapped in
    // <system-reminder>, and a bare token counter.
    expect(extractUserPrompt({
      messages: [
        { role: "user", content: "real question" },
        { role: "user", content: "<system-reminder>\nContents of /x/CLAUDE.md:\n\n# rules\n</system-reminder>" },
      ],
    })).toBe("real question");

    expect(extractUserPrompt({
      messages: [
        { role: "user", content: "real question" },
        { role: "user", content: "<system-reminder>\n<total_tokens>15000000 tokens left</total_tokens>\n</system-reminder>" },
      ],
    })).toBe("real question");
  });

  it("skips context-compaction and session-naming boilerplate", () => {
    expect(extractUserPrompt({
      messages: [
        { role: "user", content: "fix the login bug" },
        { role: "user", content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion." },
      ],
    })).toBe("fix the login bug");

    expect(extractUserPrompt({
      messages: [{ role: "user", content: "You are coming up with a succinct title and git branch name for a coding session" }],
    })).toBe("");
  });

  it("returns empty when every user turn is tool chatter", () => {
    expect(extractUserPrompt({
      messages: [
        { role: "user", content: "[tool_result]\n[tool_result]" },
        { role: "user", content: "[tool_use]" },
      ],
    })).toBe("");
  });
});
