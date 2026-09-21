import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compressedJsonResponse } from "@/lib/http/compressedJsonResponse.js";

// App Router route handlers bypass Next's compression, so the big dashboard
// JSON reads opt in explicitly. These tests lock in the negotiation rules that
// keep that safe (never send gzip to a client that refused it).

const requestWith = (acceptEncoding) => new Request("http://localhost/api/models", {
  headers: acceptEncoding === null ? {} : { "accept-encoding": acceptEncoding },
});

const bigPayload = () => ({ models: Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}`, name: `Model ${i}` })) });

describe("compressedJsonResponse", () => {
  it("gzips a large body when the client accepts gzip, and it round-trips", async () => {
    const res = compressedJsonResponse(requestWith("gzip, deflate, br"), bigPayload());
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");

    const raw = Buffer.from(await res.arrayBuffer());
    const parsed = JSON.parse(gunzipSync(raw).toString("utf8"));
    expect(parsed.models).toHaveLength(500);
  });

  it("sends identity when the client does not accept gzip", async () => {
    const res = compressedJsonResponse(requestWith("identity"), bigPayload());
    expect(res.headers.get("content-encoding")).toBeNull();
    const parsed = await res.json();
    expect(parsed.models).toHaveLength(500);
  });

  it("sends identity when no Accept-Encoding header is present", async () => {
    const res = compressedJsonResponse(requestWith(null), bigPayload());
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("treats an explicit gzip refusal (q=0) as identity", async () => {
    const res = compressedJsonResponse(requestWith("gzip;q=0, identity"), bigPayload());
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("skips compression for a body too small to benefit", async () => {
    const res = compressedJsonResponse(requestWith("gzip"), { ok: true });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("preserves status and caller headers", async () => {
    const res = compressedJsonResponse(requestWith("gzip"), bigPayload(), {
      status: 201,
      headers: { "X-Custom": "1" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });
});
