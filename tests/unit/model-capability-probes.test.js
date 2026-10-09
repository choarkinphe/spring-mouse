import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { classifyProbeFailure, explicitContextLimit, validateProbeResponse, redactEvidence } from "@/lib/modelCapabilities/classify.js";
import { makeCapabilityProbe, makeImageSample, makePdfSample, makeContextSample } from "@/lib/modelCapabilities/samples.js";
import { capabilityFingerprint, currentEvidence, evidenceCapabilities, manualCapabilities } from "@/lib/modelCapabilities/evidence.js";
import { normalizeProbeOptions } from "@/lib/modelCapabilities/runner.js";
import { capabilitiesFromDraft } from "@/shared/constants/modelCapabilities.js";
import { CAPABILITY_PROBE_VERSION, CAPABILITY_EVIDENCE_TTL_MS } from "@/shared/constants/capabilityTests.js";

const completion = (content) => ({ choices: [{ message: { content } }] });

describe("capability probe classification", () => {
  it("requires a capability-specific upstream rejection", () => {
    expect(classifyProbeFailure("vision", 400, "This model does not support image input").status).toBe("unsupported");
    for (const [status, message] of [[400, "Invalid request"], [429, "images unsupported"], [403, "not allowed image input"], [400, "image model not found"], [503, "unsupported image"]]) expect(classifyProbeFailure("vision", status, message).status).toBe("unknown");
    expect(classifyProbeFailure("vision", 400, "does not support image input", { upstream: false }).status).toBe("unknown");
  });
  it("does not confuse accepting input with understanding it", () => {
    expect(validateProbeResponse("vision", completion("I can see an image"), ["blue", "red"]).status).toBe("unknown");
    expect(validateProbeResponse("vision", completion("Blue, red"), ["blue", "red"]).status).toBe("supported");
    expect(validateProbeResponse("videoInput", completion("green, red, blue"), ["red", "blue", "green"]).status).toBe("unknown");
  });
  it("validates structured calls without executing tools", () => {
    const json = { choices: [{ message: { tool_calls: [{ function: { name: "capability_echo", arguments: '{"code":"nonce"}' } }] } }] };
    expect(validateProbeResponse("tools", json, ["nonce"]).status).toBe("supported");
    expect(validateProbeResponse("tools", completion('capability_echo {"code":"nonce"}'), ["nonce"]).status).toBe("unknown");
    expect(validateProbeResponse("structuredOutput", completion('{"code":"nonce","extra":true}'), ["nonce"]).status).toBe("unknown");
  });
  it("observes reasoning fields rather than claims of reasoning", () => {
    expect(validateProbeResponse("reasoning", completion("I reasoned carefully"), []).status).toBe("unknown");
    expect(validateProbeResponse("reasoning", { choices: [{ message: { reasoning_content: "observed" } }] }, []).status).toBe("supported");
  });
  it("records bounds separately and parses only explicit token limits", () => {
    expect(explicitContextLimit("maximum context length is 128,000 tokens")).toEqual({ explicitLimit: 128000, limitKind: "total" });
    expect(explicitContextLimit("maximum input length is 32768 tokens")).toEqual({ explicitLimit: 32768, limitKind: "input" });
    expect(evidenceCapabilities({ contextWindow: { status: "supported", context: { verifiedRetrievalTokens: 4096 } } })).toEqual({});
    expect(evidenceCapabilities({ contextWindow: { context: { explicitLimit: 32768, limitKind: "input" } } })).toEqual({});
  });
  it("redacts credentials and URL details", () => {
    expect(redactEvidence("Bearer secret-token at https://user:pass@host/ secret-token", ["secret-token"])).not.toContain("secret-token");
    expect(redactEvidence("https://user:pass@host/")).not.toContain("pass");
  });
});

describe("valid probe fixtures and budgets", () => {
  it("generates real PNG pixels and distinct left/right colors", () => {
    const sample = makeImageSample();
    const bytes = Buffer.from(sample.data, "base64");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(new Set(sample.expected).size).toBe(2);
    let offset = 8, pixels;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") pixels = inflateSync(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    expect(pixels.length).toBe(64 * (128 * 3 + 1));
  });
  it("puts a secret only inside the PDF, not in the prompt", async () => {
    const probe = await makeCapabilityProbe("pdf");
    const blocks = probe.body.messages[0].content;
    expect(blocks[0].text).not.toContain(probe.expected[0]);
    expect(Buffer.from(blocks[1].file.file_data.split(",")[1], "base64").toString()).toContain(probe.expected[0]);
    expect(Buffer.from(makePdfSample("test"), "base64").toString()).toContain("xref");
  });
  it("uses unique head/middle/tail sentinels and non-repeating filler", () => {
    const sample = makeContextSample(4096);
    expect(new Set(sample.expected).size).toBe(3);
    expect(sample.text.length).toBeGreaterThan(8000);
    expect(sample.text).not.toContain("test test test");
  });
  it("validates mode, item allowlist and bounded budgets", () => {
    expect(normalizeProbeOptions().tests).toContain("vision");
    expect(normalizeProbeOptions({ mode: "deep" }).tests).toEqual(["contextWindow"]);
    expect(() => normalizeProbeOptions({ maxRequests: 1000 })).toThrow();
    expect(() => normalizeProbeOptions({ tests: ["arbitrary-url"] })).toThrow();
    expect(() => normalizeProbeOptions({ timeoutMs: "60000" })).toThrow();
  });
});

describe("scoped evidence validity", () => {
  it("persists explicit false from the manual editor", () => {
    expect(capabilitiesFromDraft({ vision: false, tools: true })).toMatchObject({ vision: false, tools: true });
  });
  const account = { id: "a", provider: "openai-compatible-chat-example", apiKey: "key", providerSpecificData: { baseUrl: "http://127.0.0.1:9000" } };
  it("invalidates changed endpoints/keys but not OAuth token rotation", () => {
    const fingerprint = capabilityFingerprint(account, "model");
    expect(capabilityFingerprint({ ...account, accessToken: "rotated" }, "model")).toBe(fingerprint);
    expect(capabilityFingerprint({ ...account, apiKey: "different" }, "model")).not.toBe(fingerprint);
    expect(capabilityFingerprint(account, "other-model")).not.toBe(fingerprint);
  });
  it("expires old evidence, preserves explicit false and manual priority", () => {
    const fingerprint = capabilityFingerprint(account, "model");
    const now = Date.now();
    const result = { status: "unsupported", fingerprint, probeVersion: CAPABILITY_PROBE_VERSION, testedAt: new Date(now).toISOString() };
    const profile = { fingerprint, evidence: { vision: result } };
    expect(evidenceCapabilities(currentEvidence(profile, fingerprint, now))).toEqual({ vision: false });
    expect(currentEvidence(profile, fingerprint, now + CAPABILITY_EVIDENCE_TTL_MS + 1)).toEqual({});
    expect(currentEvidence(profile, "different", now)).toEqual({});
    expect(manualCapabilities({ source: "official", capabilities: { vision: true } })).toEqual({});
    expect(manualCapabilities({ manualCapabilities: { vision: false } })).toEqual({ vision: false });
  });
});
