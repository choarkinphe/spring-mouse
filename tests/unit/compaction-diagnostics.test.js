import { describe, expect, it, vi } from "vitest";
import { detectCompactionRequest, compactionRequestShape, compactionErrorShape, createCompactionDiagnostics } from "../../open-sse/utils/compactionDiagnostics.js";
import { COMPACTION_DIAGNOSTICS_LIMITS } from "../../open-sse/config/compactionDiagnostics.js";

const uuid = "12345678-abcd-4321-abcd-123456789abc";

describe("compaction diagnostics", () => {
  it("uses request markers only, not post-compaction markers or user text", () => {
    expect(detectCompactionRequest(new Headers({ "x-cc-compaction-request": "manual" }), {}, "/v1/messages")).toEqual(["x-cc-compaction-request"]);
    expect(detectCompactionRequest({ "X-Claude-Code-Compaction": "auto" }, {}, "/v1/messages")).toEqual(["x-claude-code-compaction"]);
    expect(detectCompactionRequest({ "x-cc-context-compacted": "true" }, { messages: [{ content: "please compact" }] }, "/v1/messages")).toEqual([]);
    expect(detectCompactionRequest({ "x-cc-compaction-request": "false" }, {}, "/v1/messages")).toEqual([]);
    expect(detectCompactionRequest({}, { _compact: true }, "/v1/responses/compact")).toEqual(["compact-body-flag", "compact-endpoint"]);
  });

  it("captures shape and budgets without retaining prompt/tool/reasoning text", () => {
    const body = { model: "secret-model", messages: [{ role: "user", content: [{ type: "text", text: "secret prompt" }, { type: "image", source: { data: "secret-image" } }] }, { role: "assistant", content: "private answer", tool_calls: [{ function: { arguments: "secret args" } }] }], tools: [{ name: "secret tool", input_schema: { secret: "schema" } }], max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 10000, text: "private thought" }, reasoning_effort: "high", stream: true };
    const before = JSON.stringify(body);
    const shape = compactionRequestShape(body);
    expect(shape).toMatchObject({ messageCount: 2, toolCount: 1, toolCalls: 1, roleCounts: { user: 1, assistant: 1 }, blockCounts: { text: 1, image: 1 }, maxTokens: 64000, thinkingType: "enabled", thinkingBudget: 10000, reasoningEffort: "high" });
    expect(JSON.stringify(shape)).not.toMatch(/secret|private/);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("bounds traversal and buckets unknown labels", () => {
    const shape = compactionRequestShape({ messages: Array.from({ length: COMPACTION_DIAGNOSTICS_LIMITS.maxItems + 1 }, () => ({ role: "sensitive role", content: [{ type: "sensitive block", text: "hi" }] })), thinking: { type: "secret" }, reasoning_effort: "secret" });
    expect(shape.sampled).toBe(true);
    expect(shape.roleCounts.other).toBe(COMPACTION_DIAGNOSTICS_LIMITS.maxItems);
    expect(JSON.stringify(shape)).not.toContain("sensitive");
    expect(shape.thinkingType).toBe("other");
  });

  it("extracts CodeBuddy error codes but never error messages", () => {
    const shape = compactionErrorShape(JSON.stringify({ code: 11133, msg: "secret rejected prompt", requestId: uuid, extError: { code: "model_param_invalid", StatusCode: 400, message: "secret token" } }));
    expect(shape).toMatchObject({ code: 11133, nestedCode: "model_param_invalid", status: 400, upstreamRequestId: uuid });
    expect(JSON.stringify(shape)).not.toMatch(/secret|prompt/);
    expect(compactionErrorShape("x".repeat(COMPACTION_DIAGNOSTICS_LIMITS.maxErrorChars + 1))).toEqual({ parsed: false, oversized: true });
    expect(compactionErrorShape({ code: "Bearer secret" }).code).toBe("other");
  });

  it("correlates safe request ids, hashes account/model ids, emits terminal once", () => {
    let now = 100;
    const log = { errorLine: vi.fn() };
    const diag = createCompactionDiagnostics({ headers: { "x-cc-compaction-request": "secret header", Authorization: "secret auth" }, body: { input: "secret text" }, requestId: uuid, connectionId: "private account", provider: "private provider", model: "private model", sourceFormat: "claude", targetFormat: "openai", log, now: () => now });
    diag.emit("dispatch", { body: { messages: [{ role: "user", content: "private text" }] } });
    now = 200;
    diag.emit("end", { status: 400, outcome: "upstream_rejected", error: '{"code":11133}' });
    diag.emit("end", { outcome: "response_complete" });
    expect(log.errorLine).toHaveBeenCalledTimes(2);
    const record = JSON.parse(log.errorLine.mock.calls[1][2].split("COMPACTION-DIAG | ")[1]);
    expect(record).toMatchObject({ requestId: uuid, elapsedMs: 100, status: 400, outcome: "upstream_rejected", upstreamError: { code: 11133 } });
    expect(record.accountHash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(log.errorLine.mock.calls)).not.toMatch(/secret|private/);
  });

  it("does nothing for ordinary requests and fails open when logger throws", () => {
    expect(createCompactionDiagnostics({ body: {}, headers: {} })).toBeNull();
    const diag = createCompactionDiagnostics({ body: { _compact: true }, log: { errorLine() { throw new Error("broken logger"); } } });
    expect(() => diag.emit("end", { outcome: "response_complete" })).not.toThrow();
  });
});
