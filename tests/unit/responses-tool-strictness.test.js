import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

// Claude Desktop's Agent has an optional, single-value isolation enum. Making
// every property required changes a normal task into a mandatory worktree task.
const schema = () => ({
  type: "object",
  properties: {
    prompt: { type: "string" },
    subagent_type: { type: "string" },
    isolation: { type: "string", enum: ["worktree"] },
    run_in_background: { type: "boolean" },
    options: { type: "object", properties: { resume: { type: "string" } } },
  },
  required: ["prompt", "subagent_type"],
  additionalProperties: false,
});
const credentials = () => ({ connectionId: "fixture", providerSpecificData: {} });
const messages = (tools) => ({
  messages: [{ role: "user", content: "Read-only task in a non-Git folder; do not use worktree isolation." }],
  tools,
  stream: true,
});
const executeBody = (body) => new CodexExecutor().transformRequest("gpt-6-astra", body, true, credentials());

describe("tool schema strictness across the Claude/Chat → Responses → Codex path", () => {
  it("keeps Claude Agent isolation optional in the serialized upstream request", () => {
    const original = schema();
    const body = messages([{ name: "Agent", description: "Run a subagent", input_schema: original }]);
    const converted = translateRequest("claude", "openai-responses", "gpt-6-astra", body, true, credentials());
    const sent = JSON.parse(JSON.stringify(executeBody(converted)));

    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0].name).toBe("Agent");
    expect(sent.tools[0].strict).toBe(false);
    expect(sent.tools[0].parameters).toEqual(schema());
    expect(sent.tools[0].parameters.required).not.toContain("isolation");
    expect(sent.tools[0].parameters.properties.options.required).toBeUndefined();
    expect(original).toEqual(schema());
  });

  it.each([false, true])("preserves explicitly requested Claude strict=%s", (strict) => {
    const body = messages([{ name: "Agent", input_schema: schema(), strict }]);
    const converted = translateRequest("claude", "openai-responses", "gpt-6-astra", body, true, credentials());
    expect(executeBody(converted).tools[0].strict).toBe(strict);
  });

  it.each([undefined, false, true])("preserves Chat defaults and explicit strict=%s", (strict) => {
    const body = messages([{ type: "function", function: { name: "Agent", parameters: schema(), strict } }]);
    const converted = openaiToOpenAIResponsesRequest("gpt-6-astra", body, true, credentials());
    expect(converted.tools[0].strict).toBe(strict ?? false);
    expect(executeBody(converted).tools[0].strict).toBe(strict ?? false);
  });

  it.each([undefined, false, true])("preserves native Responses strict=%s without changing its default", (strict) => {
    const tool = { type: "function", name: "Agent", parameters: schema() };
    if (strict !== undefined) tool.strict = strict;
    const body = { input: "probe", tools: [tool], stream: true };
    const converted = openaiToOpenAIResponsesRequest("gpt-6-astra", body, true, credentials());
    const sent = JSON.parse(JSON.stringify(executeBody(converted)));
    expect(sent.tools[0].strict).toBe(strict);
    expect(Object.hasOwn(sent.tools[0], "strict")).toBe(strict !== undefined);
  });

  it("retains non-strict Chat semantics when the Codex executor directly flattens a legacy tool", () => {
    const sent = executeBody({
      input: "probe", stream: true,
      tools: [{ type: "function", function: { name: "Agent", parameters: schema() } }],
    });
    expect(sent.tools[0].strict).toBe(false);
    expect(sent.tools[0].parameters.required).toEqual(["prompt", "subagent_type"]);
  });
});
