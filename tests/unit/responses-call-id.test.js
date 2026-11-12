import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { normalizeResponsesCallIds } from "../../open-sse/utils/responsesCallId.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const longId = "call_" + "x".repeat(62); // Production failure: 67 > 64
const pair = (id, custom = false) => [
  { type: custom ? "custom_tool_call" : "function_call", call_id: id, name: "probe", arguments: "{}", input: "private payload" },
  { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: id, output: "private result" },
];
const ids = (body) => body.input.filter((item) => item?.call_id).map((item) => item.call_id);
const native = (body) => new CodexExecutor().transformRequest("gpt-6-astra", body, true, {
  connectionId: "test-call-id", providerSpecificData: {},
});

describe("Responses call ID normalization", () => {
  it.each([false, true])("normalizes paired native calls and results (custom=%s)", (custom) => {
    const body = { input: pair(longId, custom) };
    native(body);
    expect(ids(body)[0].length).toBeLessThanOrEqual(64);
    expect(ids(body)[0]).toBe(ids(body)[1]);
    expect(body.input[0].input).toBe("private payload");
    expect(body.input[1].output).toBe("private result");
  });

  it.each([1, 63, 64])("preserves compliant %s-character IDs", (length) => {
    const id = "a".repeat(length);
    const body = { input: pair(id) };
    normalizeResponsesCallIds(body);
    expect(ids(body)).toEqual([id, id]);
  });

  it("preserves distinct suffixes on IDs with identical first 64 characters", () => {
    const prefix = "a".repeat(64);
    const body = { input: [...pair(prefix + "one"), ...pair(prefix + "two")] };
    normalizeResponsesCallIds(body);
    const mapped = ids(body);
    expect(mapped[0]).toBe(mapped[1]);
    expect(mapped[2]).toBe(mapped[3]);
    expect(mapped[0]).not.toBe(mapped[2]);
    expect(mapped.every((id) => id.length <= 64)).toBe(true);
  });

  it("does not collide with an existing short ID equal to the default replacement", () => {
    const short = "call_sm_" + createHash("sha256").update(longId).digest("base64url");
    const body = { input: [...pair(longId), ...pair(short)] };
    normalizeResponsesCallIds(body);
    expect(ids(body).slice(2)).toEqual([short, short]);
    expect(ids(body)[0]).not.toBe(short);
    expect(ids(body)[0]).toBe(ids(body)[1]);
    const reordered = { input: [...pair(short), ...pair(longId)] };
    normalizeResponsesCallIds(reordered);
    expect(ids(reordered)[2]).toBe(ids(body)[0]);
  });

  it("is deterministic across calls and idempotent on retries", () => {
    const a = { input: pair(longId) };
    const b = structuredClone(a);
    normalizeResponsesCallIds(a);
    normalizeResponsesCallIds(b);
    expect(a).toEqual(b);
    const before = structuredClone(a);
    normalizeResponsesCallIds(a);
    expect(a).toEqual(before);
  });

  it("only changes top-level call_id fields, not item IDs or nested data", () => {
    const body = { input: [null, "reference", { type: "message", id: longId,
      content: [{ type: "input_text", text: longId, call_id: longId }] }, ...pair(longId)] };
    normalizeResponsesCallIds(body);
    expect(body.input[2].id).toBe(longId);
    expect(body.input[2].content[0]).toEqual({ type: "input_text", text: longId, call_id: longId });
    expect(body.input[0]).toBeNull();
    expect(body.input[1]).toBe("reference");
  });

  it("handles missing input, missing IDs and non-string IDs without inventing IDs", () => {
    for (const body of [{}, { input: "hello" }, { input: [{}, { call_id: null }, { call_id: 5 }] }]) {
      const original = structuredClone(body);
      expect(normalizeResponsesCallIds(body)).toBe(body);
      expect(body).toEqual(original);
    }
  });

  it.each([FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI])("normalizes %s ingress through the real translator and Codex executor", (format) => {
    const body = format === FORMATS.OPENAI_RESPONSES
      ? { model: "gpt-6-astra", input: pair(longId) }
      : { model: "gpt-6-astra", messages: [
        { role: "assistant", content: null, tool_calls: [{ id: longId, type: "function", function: { name: "probe", arguments: "{}" } }] },
        { role: "tool", tool_call_id: longId, content: "private result" },
      ] };
    const translated = translateRequest(format, FORMATS.OPENAI_RESPONSES, body.model, body, true, null, "codex");
    native(translated);
    expect(ids(translated)).toHaveLength(2);
    expect(ids(translated)[0]).toBe(ids(translated)[1]);
    expect(ids(translated)[0].length).toBeLessThanOrEqual(64);
    const expected = normalizeResponsesCallIds({ input: pair(longId) });
    expect(ids(translated)).toEqual(ids(expected));
  });
});
