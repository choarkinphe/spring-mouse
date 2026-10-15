import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";

const tool = name => ({ type: "function", function: { name, parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } });
describe.each([CodeBuddyIntlExecutor, CodeBuddyExecutor])("%s named tool choice", Executor => {
  const executor = new Executor();
  const transform = body => executor.transformRequest("deepseek-v4.1-flash", body, true, {});
  it("forces the named tool with a string choice and preserves its schema", () => {
    const body = { messages: [], tools: [tool("other"), tool("status_probe")], tool_choice: { type: "function", function: { name: "status_probe" } } };
    const original = structuredClone(body);
    const result = transform(body);
    expect(result.tool_choice).toBe("required");
    expect(result.tools).toEqual([body.tools[1]]);
    expect(body).toEqual(original);
  });
  it.each(["auto", "none", "required"])("preserves string choice %s and the full tool list", choice => {
    const body = { messages: [], tools: [tool("first"), tool("second")], tool_choice: choice };
    const result = transform(body);
    expect(result.tool_choice).toBe(choice);
    expect(result.tools).toEqual(body.tools);
  });
  it("does not substitute another tool for an unknown forced name", () => {
    const body = { messages: [], tools: [tool("other")], tool_choice: { type: "function", function: { name: "missing" } } };
    expect(transform(body).tool_choice).toEqual(body.tool_choice);
  });
  it("supports Claude Desktop's named choice through the real translator", () => {
    const translated = claudeToOpenAIRequest("deepseek-v4.1-flash", {
      messages: [{ role: "user", content: "Synthetic protocol check" }],
      tools: [{ name: "other", input_schema: tool("other").function.parameters }, { name: "status_probe", input_schema: tool("status_probe").function.parameters }],
      tool_choice: { type: "tool", name: "status_probe" },
    }, true);
    const result = transform(translated);
    expect(result.tool_choice).toBe("required");
    expect(result.tools.map(t => t.function.name)).toEqual(["status_probe"]);
    expect(result.tools[0].function.parameters.required).toEqual(["ok"]);
  });
});
