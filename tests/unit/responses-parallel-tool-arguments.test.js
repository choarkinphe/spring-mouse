import { describe, expect, it } from "vitest";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const args = n => JSON.stringify({ file_path: `/tmp/file-${n}.js` });
const item = n => ({ type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "Read", arguments: "" });
const added = n => ({ type: "response.output_item.added", output_index: n + 2, item: item(n) });
const delta = (n, value = args(n)) => ({ type: "response.function_call_arguments.delta", output_index: n + 2, item_id: `fc_${n}`, delta: value });
const argsDone = n => ({ type: "response.function_call_arguments.done", output_index: n + 2, item_id: `fc_${n}`, arguments: args(n) });
const done = n => ({ type: "response.output_item.done", output_index: n + 2, item: { ...item(n), arguments: args(n) } });

function convert(events, format = FORMATS.CLAUDE) {
  const state = initState(format);
  return [...events, { type: "response.completed", response: {} }]
    .flatMap(event => translateResponse(FORMATS.OPENAI_RESPONSES, format, event, state));
}

function tools(events) {
  const blocks = new Map();
  for (const event of convert(events)) {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      blocks.set(event.index, { id: event.content_block.id, json: "" });
    }
    if (event.delta?.type === "input_json_delta") blocks.get(event.index).json += event.delta.partial_json;
  }
  return [...blocks.values()].map(block => ({ id: block.id, input: JSON.parse(block.json || "{}") }));
}

const expected = [0, 1, 2].map(n => ({ id: `call_${n}`, input: JSON.parse(args(n)) }));

describe("Responses tool arguments survive the OpenAI and Claude bridge", () => {
  it("routes interleaved parallel fragments by item identity, not completion order", () => {
    const events = [added(0), added(1), added(2), delta(2), delta(0, args(0).slice(0, 12)), done(2), delta(1), done(1), delta(0, args(0).slice(12)), done(0)];
    expect(tools(events)).toEqual(expected);
    const calls = convert(events, FORMATS.OPENAI).flatMap(e => e.choices?.[0]?.delta?.tool_calls || []);
    for (let n = 0; n < 3; n++) {
      expect(calls.filter(c => c.index === n).map(c => c.function?.arguments || "").join("")).toBe(args(n));
    }
  });

  it("recovers arguments present only in output_item.done", () => {
    expect(tools([added(0), added(1), added(2), done(2), done(0), done(1)])).toEqual(expected);
  });

  it("recovers arguments present only in function_call_arguments.done", () => {
    expect(tools([added(0), added(1), added(2), argsDone(1), argsDone(2), argsDone(0)])).toEqual(expected);
  });

  it("does not duplicate delta arguments when both completion snapshots arrive", () => {
    expect(tools([added(0), delta(0), argsDone(0), done(0), done(0)])).toEqual(expected.slice(0, 1));
  });

  it("appends only the missing suffix from a completion snapshot", () => {
    expect(tools([added(0), delta(0, args(0).slice(0, 10)), argsDone(0), done(0)])).toEqual(expected.slice(0, 1));
  });

  it("retains arguments supplied in the added item", () => {
    expect(tools([{ ...added(0), item: { ...item(0), arguments: args(0) } }, done(0)])).toEqual(expected.slice(0, 1));
  });

  it("supports sequential legacy events without output_index or item_id", () => {
    const events = [added(0), delta(0), done(0), added(1), delta(1), done(1)].map(event => {
      const { output_index, item_id, ...legacy } = event;
      return legacy;
    });
    expect(tools(events)).toEqual(expected.slice(0, 2));
  });

  it("routes output_index-only deltas to the correct parallel tool", () => {
    const events = [added(0), added(1), delta(1), delta(0), done(1), done(0)].map(event => {
      const { item_id, ...withoutId } = event;
      return withoutId;
    });
    expect(tools(events)).toEqual(expected.slice(0, 2));
  });

  it("preserves custom tool completion input without duplicating it", () => {
    const custom = { type: "custom_tool_call", id: "custom_0", call_id: "call_custom", name: "custom", input: "" };
    const events = [
      { type: "response.output_item.added", output_index: 3, item: custom },
      { type: "response.custom_tool_call_input.done", output_index: 3, item_id: custom.id, input: "raw tool input" },
      { type: "response.output_item.done", output_index: 3, item: { ...custom, input: "raw tool input" } },
    ];
    const calls = convert(events, FORMATS.OPENAI).flatMap(e => e.choices?.[0]?.delta?.tool_calls || []);
    expect(calls.map(c => c.function?.arguments || "").join("")).toBe("raw tool input");
    expect(calls.filter(c => c.id).map(c => c.id)).toEqual(["call_custom"]);
  });

  it("routes item_id-only deltas to the correct parallel tool", () => {
    const events = [added(0), added(1), delta(1), delta(0), done(1), done(0)].map(event => {
      const { output_index, ...withoutIndex } = event;
      return withoutIndex;
    });
    expect(tools(events)).toEqual(expected.slice(0, 2));
  });
});
