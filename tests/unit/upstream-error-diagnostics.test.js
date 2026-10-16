import { describe, expect, it } from "vitest";
import { buildUpstreamError, upstreamErrorDiagnostics } from "../../open-sse/utils/error.js";

describe("safe upstream error diagnostics", () => {
  it("retains known classifications and numeric business codes without payload text", () => {
    const raw = JSON.stringify({ code: 11133, error: { type: "rate_limit_error", code: "insufficient_quota", message: "private prompt" }, base_resp: { status_code: 1008, status_msg: "private key" }, request_id: "private id" });
    const shape = upstreamErrorDiagnostics(raw, { origin: "sse_first_output_timeout", failureKind: "admission_limit" });
    expect(shape).toEqual({ version: 1, parsed: true, oversized: false, code: 11133, type: "rate_limit_error", nestedCode: "insufficient_quota", baseCode: 1008, origin: "sse_first_output_timeout", kind: "admission_limit" });
    expect(JSON.stringify(shape)).not.toMatch(/private|message|request_id/);
  });

  it("buckets untrusted labels, objects and nonfinite or excessive codes", () => {
    const raw = JSON.stringify({ code: "private-token", type: { text: "private" }, error: { code: 1e20 }, baseResp: { statusCode: "private message" } });
    expect(upstreamErrorDiagnostics(raw, { origin: "private", failureKind: "private" })).toMatchObject({ code: "other", type: "other", nestedCode: "other", baseCode: "other", origin: null, kind: null });
  });

  it.each(["", "not json", "null", "[]", "42"])("rejects non-object payload %j", (raw) => {
    expect(upstreamErrorDiagnostics(raw).parsed).toBe(false);
  });

  it("bounds parsing and distinguishes empty output from upstream errors", () => {
    expect(upstreamErrorDiagnostics("x".repeat(16001))).toMatchObject({ parsed: false, oversized: true });
    expect(upstreamErrorDiagnostics("", { failureKind: "empty_output" })).toMatchObject({ parsed: false, kind: "empty_output" });
    const response = new Response(null, { status: 200, headers: { "retry-after": "12" } });
    const error = buildUpstreamError(response, '{"error":{"type":"api_error"}}', "fixture", "sse", { failureKind: "upstream_error", diagnostics: { secret: "private" } });
    expect(error).toMatchObject({ status: 200, retryAfterMs: 12000, diagnostics: { kind: "upstream_error", type: "api_error" } });
    expect(JSON.stringify(error.diagnostics)).not.toContain("private");
  });
});
