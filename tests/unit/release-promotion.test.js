import { describe, expect, it } from "vitest";
import { validateRelease } from "../../scripts/promote-release.mjs";

function record() {
  return {
    image: `choarkinphe/spring-mouse@sha256:${"a".repeat(64)}`,
    rollbackImage: `choarkinphe/spring-mouse@sha256:${"b".repeat(64)}`,
    revision: "c".repeat(40), version: "0.4.214",
    gates: Object.fromEntries(["unitTests", "containerSmoke", "cancellationMatrix", "resourceRecovery", "realUpstream", "proxyPath", "rollbackRehearsal", "runtimeFingerprint"].map((key) => [key, { passed: true, evidence: "fixture-only" }])),
    observation: { durationSeconds: 300, passed: true, evidence: "fixture-only" },
    approvals: [{ name: "owner", role: "code-owner", approved: true, at: "2026-10-04" }, { name: "release", role: "release-owner", approved: true, at: "2026-10-04" }],
  };
}

describe("release promotion gates", () => {
  it("validates an explicitly completed record", () => { expect(validateRelease(record()).version).toBe("0.4.214"); });
  it("rejects mutable images and incomplete evidence", () => {
    const mutable = record(); mutable.image = "choarkinphe/spring-mouse:latest"; expect(() => validateRelease(mutable)).toThrow(/immutable/);
    for (const key of Object.keys(record().gates)) { const value = record(); value.gates[key].passed = false; expect(() => validateRelease(value)).toThrow(key); }
  });
  it("requires five minutes and two distinct owner approvals", () => {
    const short = record(); short.observation.durationSeconds = 299; expect(() => validateRelease(short)).toThrow(/five-minute/);
    const single = record(); single.approvals[1].name = "owner"; expect(() => validateRelease(single)).toThrow(/two explicit/);
  });
});
