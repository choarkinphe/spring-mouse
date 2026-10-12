import { describe, expect, it } from "vitest";
import { summarizeSmokeFailure, smokeFailureAnnotation } from "../fixtures/release-smoke/failure-summary.mjs";

describe("public smoke failure annotations", () => {
  it("extracts login status and fixture line without raw stderr", () => {
    const result = summarizeSmokeFailure("http-smoke", "", "AssertionError [ERR_ASSERTION]: /api/auth/login: HTTP 500\n at api (file:///fixture/tests/fixtures/release-smoke/verify.mjs:14:10)\nsecret=unsafe");
    expect(result).toEqual({ stage: "http-smoke", http: { endpoint: "auth-login", status: 500 }, location: { file: "verify.mjs", line: 14 } });
    expect(smokeFailureAnnotation(result)).not.toContain("unsafe");
  });
  it("preserves safe delivery and persistence counters", () => {
    const result = summarizeSmokeFailure("persistence", JSON.stringify({ check: "routing-delivery", health: { enqueued: 104, sent: 20, failed: 84, secret: "unsafe" } }), JSON.stringify({ check: "smoke-persistence", counts: { usageRows: 27, attempts: 8, completedAttempts: 2, selectedAccounts: 2 } }));
    expect(result.delivery.failed).toBe(84);
    expect(result.persistence.completedAttempts).toBe(2);
    expect(smokeFailureAnnotation(result)).toContain('"completedAttempts":2');
    expect(smokeFailureAnnotation(result)).not.toContain("unsafe");
  });
  it("does not publish arbitrary fields or annotation injections", () => {
    const unsafe = "secret\n::error::injected";
    const annotation = smokeFailureAnnotation({ stage: unsafe, http: { endpoint: unsafe, category: unsafe, status: unsafe }, location: { file: unsafe, line: unsafe }, secret: unsafe });
    expect(annotation).not.toContain("secret");
    expect(annotation).not.toContain("injected");
    expect(annotation.split("\n")).toHaveLength(1);
  });
});
