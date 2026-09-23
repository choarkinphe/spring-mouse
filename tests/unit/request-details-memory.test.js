import { describe, expect, it } from "vitest";
import { __test__ } from "@/lib/db/repos/requestDetailsRepo.js";
import { compactJsonField } from "@/lib/requestDetailCompact.js";

describe("request detail memory bounds", () => {
  it("compacts large fields before they enter the delayed write buffer", () => {
    const huge = "x".repeat(20_000);
    const source = {
      id: "detail-memory-test",
      provider: "openai",
      request: {
        headers: { authorization: "secret", "x-request-id": "safe" },
        messages: [{ role: "user", content: huge }],
      },
      providerRequest: { input: huge },
      response: { content: huge },
    };

    const record = __test__.prepareRecord(source, { maxJsonSize: 1024 });

    expect(record.request._truncated).toBe(true);
    expect(record.providerRequest._truncated).toBe(true);
    expect(record.response._truncated).toBe(true);
    // Every oversized field is replaced by a bounded preview+summary, and the
    // lifted user prompt has its own cap, so the record cannot grow with the
    // input. The bound is the four compacted fields (~1KB of preview each) plus
    // the 2048-char prompt ceiling — what matters is that it is a CONSTANT, not
    // a function of the 20KB input.
    expect(record.userPrompt.length).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(record).length).toBeLessThan(12_000);
    expect(source.request.headers.authorization).toBe("secret");
  });

  it("detects a large string before full JSON serialization", () => {
    let toJsonCalls = 0;
    const value = {
      content: "x".repeat(2 * 1024 * 1024),
      toJSON() {
        toJsonCalls += 1;
        return this;
      },
    };

    const compacted = compactJsonField(value, 1024);

    expect(compacted._truncated).toBe(true);
    expect(compacted._originalSizeExact).toBe(false);
    expect(compacted._preview.length).toBeLessThanOrEqual(200);
    expect(toJsonCalls).toBe(0);
  });

  it("bounds the delayed queue by dropping the oldest records", () => {
    const buffer = [{ id: "old-1" }, { id: "old-2" }, { id: "keep" }];
    const dropped = __test__.appendBounded(buffer, { id: "new" }, 3);

    expect(dropped).toBe(1);
    expect(buffer.map((record) => record.id)).toEqual(["old-2", "keep", "new"]);
  });
});
