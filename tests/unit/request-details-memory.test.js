import { describe, expect, it } from "vitest";
import { __test__ } from "@/lib/db/repos/requestDetailsRepo.js";

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
    expect(JSON.stringify(record).length).toBeLessThan(2_000);
    expect(source.request.headers.authorization).toBe("secret");
  });
});
