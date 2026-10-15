import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { normalizeCodexHostedHistory } from "../../open-sse/utils/codexHostedHistory.js";

function normalizeTools(tools) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    stream: true,
  };

  executor.transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-tools",
    providerSpecificData: {},
  });

  return body.tools;
}

describe("CodexExecutor tool normalization", () => {
  it("strips Unicode property escape patterns from nested tool schemas", () => {
    const tools = normalizeTools([{
      type: "function",
      name: "artifact",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[\\p{Cc}]+$" },
          safe: { type: "string", pattern: "^[a-z]+$" },
        },
      },
    }]);

    expect(tools[0].parameters.properties.name.pattern).toBeUndefined();
    expect(tools[0].parameters.properties.safe.pattern).toBe("^[a-z]+$");
  });

  it("preserves Responses text.format for structured outputs", () => {
    const executor = new CodexExecutor();
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    };
    const body = {
      model: "gpt-5.4-mini",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test for session title" }] }],
      stream: true,
      metadata: { unsupported: true },
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
    };

    executor.transformRequest("gpt-5.4-mini", body, true, {
      connectionId: "test-codex-structured-output",
      providerSpecificData: {},
    });

    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "codex_output_schema",
        strict: true,
        schema,
      },
    });
    expect(body.metadata).toBeUndefined();
  });

  it("preserves Responses-native tool_search tools", () => {
    const tools = normalizeTools([
      {
        type: "tool_search",
        execution: "sync",
        description: "Discover deferred tools",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "namespace",
        name: "codex_app",
        description: "app tools",
        tools: [
          {
            type: "function",
            name: "automation_update",
            description: "automation",
            parameters: { type: "object", properties: {} },
            defer_loading: true,
          },
        ],
      },
      {
        type: "function",
        name: "plain_fn",
        description: "plain",
        parameters: { type: "object", properties: {} },
      },
    ]);

    expect(tools.map((tool) => `${tool.type}:${tool.name || ""}`)).toEqual([
      "tool_search:",
      "namespace:codex_app",
      "function:plain_fn",
    ]);
  });

  it("preserves hosted Responses tools", () => {
    const tools = normalizeTools([
      { type: "web_search", search_context_size: "medium" },
      { type: "image_generation", size: "1024x1024" },
      { type: "mcp", server_label: "docs", server_url: "https://example.com/mcp" },
      { type: "local_shell" },
      { type: "code_interpreter", container: { type: "auto" } },
      { type: "computer", display_width: 1024, display_height: 768, environment: "browser" },
    ]);

    expect(tools.map((tool) => tool.type)).toEqual([
      "web_search",
      "image_generation",
      "mcp",
      "local_shell",
      "code_interpreter",
      "computer",
    ]);
  });

  it("preserves custom freeform tools with format payloads", () => {
    const tools = normalizeTools([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);

    expect(tools).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);
  });
});

describe("Codex hosted search history on no-tool turns", () => {
  const search = () => ({
    type: "web_search_call", id: "ws_test", status: "completed",
    action: { type: "search", query: "PRIVATE_QUERY" },
  });
  const transform = (extra) => new CodexExecutor().transformRequest("gpt-6-astra", {
    model: "gpt-6-astra", input: [search()], ...extra,
  }, true, {});

  it.each([{}, { tools: [] }, { tools: [], tool_choice: "none" }, { tool_choice: "auto" }])(
    "restores a declaration without authorizing new searches: %j", (extra) => {
      const body = transform(extra);
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.tool_choice).toBe("none");
      expect(body.input).toEqual([search()]);
    },
  );

  it("keeps all history and ciphertext and is idempotent", () => {
    const input = [search(), { type: "reasoning", encrypted_content: "PRIVATE_CIPHERTEXT" }, {
      type: "message", role: "assistant", content: [{ type: "output_text", text: "PRIVATE_TEXT", annotations: [{ type: "url_citation", url: "https://example.com", start_index: 0, end_index: 1 }] }],
    }];
    const body = { input, tools: [], tool_choice: "none" };
    const snapshot = structuredClone(body.input);
    expect(normalizeCodexHostedHistory(body).declarationRestored).toBe(true);
    expect(normalizeCodexHostedHistory(body).declarationRestored).toBe(false);
    expect(body.input).toBe(input);
    expect(body.input).toEqual(snapshot);
    expect(body.tools).toHaveLength(1);
  });

  it.each([undefined, "auto", "required", { type: "function", name: "lookup" }])(
    "does not change active function tool authority: %j", (tool_choice) => {
      const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
      const body = transform({ tools: structuredClone(tools), tool_choice });
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toEqual(tool_choice);
    },
  );

  it.each(["required", { type: "web_search" }, { type: "function", name: "unknown" }])(
    "does not reinterpret an explicit tool request with an empty tool set: %j", (tool_choice) => {
      expect(transform({ tools: [], tool_choice }).tools).toEqual([]);
    },
  );

  it("supports explicitly disabled function tools without enabling any tool", () => {
    const body = transform({ tools: [{ type: "function", name: "lookup" }], tool_choice: "none" });
    expect(body.tools.map((tool) => tool.type)).toEqual(["function", "web_search"]);
    expect(body.tool_choice).toBe("none");
  });

  it.each(["web_search", "web_search_preview"])("preserves existing %s authority and settings", (type) => {
    const tools = [{ type, search_context_size: "low" }];
    const body = transform({ tools, tool_choice: "auto" });
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
  });

  it("does not invent a tool for ordinary history or malformed tool declarations", () => {
    expect(transform({ input: [{ role: "user", content: "hello" }], tools: [] }).tools).toEqual([]);
    expect(transform({ tools: "invalid", tool_choice: "none" }).tools).toBe("invalid");
  });

  it("only emits anonymous shape metadata", () => {
    const body = { input: [search(), { type: "PRIVATE_TYPE", content: "PRIVATE_TEXT" }], tools: [], tool_choice: "none" };
    const metadata = normalizeCodexHostedHistory(body);
    expect(metadata).toEqual({ inputItems: 2, searchHistoryItems: 1, toolCountBefore: 0, searchDeclaredBefore: false, declarationRestored: true, toolsDisabled: true });
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE");
  });
});
