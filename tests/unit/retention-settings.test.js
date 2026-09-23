import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-retention-settings-"));

let PATCH;

beforeAll(async () => {
  ({ PATCH } = await import("@/app/api/settings/route.js"));
});

function patchRequest(body) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The writer process turns these values into a delete cutoff, so a malformed
 * value must be rejected at the boundary rather than stored. A stored negative
 * or non-numeric value would make the writer silently fall back to its default,
 * quietly ignoring what the operator asked for.
 */
describe("retention settings validation", () => {
  it("accepts valid day counts, including 0 for keep-forever", async () => {
    for (const days of [0, 1, 30, 90, 3650]) {
      const res = await PATCH(patchRequest({ usageRetentionDays: days, requestDetailsRetentionDays: days }));
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.usageRetentionDays).toBe(days);
      expect(payload.requestDetailsRetentionDays).toBe(days);
    }
  });

  it("rejects a negative day count", async () => {
    const res = await PATCH(patchRequest({ usageRetentionDays: -1 }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer day count", async () => {
    const res = await PATCH(patchRequest({ requestDetailsRetentionDays: 7.5 }));
    expect(res.status).toBe(400);
  });

  it("rejects a numeric string instead of coercing it", async () => {
    // The UI sends numbers; a string here means a hand-rolled request, and
    // coercing would hide that the caller got the type wrong.
    const res = await PATCH(patchRequest({ usageRetentionDays: "30" }));
    expect(res.status).toBe(400);
  });

  it("rejects an absurdly large window", async () => {
    const res = await PATCH(patchRequest({ usageRetentionDays: 100000 }));
    expect(res.status).toBe(400);
  });

  it("leaves other settings untouched when rejecting", async () => {
    // A rejected PATCH must not partially apply.
    const before = await PATCH(patchRequest({ usageRetentionDays: 45 }));
    expect(before.status).toBe(200);

    const rejected = await PATCH(patchRequest({ usageRetentionDays: -5, pricingAutoSyncEnabled: true }));
    expect(rejected.status).toBe(400);

    const { GET } = await import("@/app/api/settings/route.js");
    const payload = await (await GET()).json();
    expect(payload.usageRetentionDays).toBe(45);
    expect(payload.pricingAutoSyncEnabled).not.toBe(true);
  });
});
