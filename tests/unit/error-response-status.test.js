import { describe, expect, it } from "vitest";
import { createErrorResult, errorResponse, unavailableResponse } from "../../open-sse/utils/error.js";

describe("failure HTTP status contract", () => {
  it.each([200, 204, 301, 0, null, undefined, NaN, 600, 429.5])("never serves an error with invalid status %s", async (status) => {
    const result = createErrorResult(status, "upstream failed");
    expect(result.status).toBe(502);
    expect(result.response.status).toBe(502);
    expect(errorResponse(status, "upstream failed").status).toBe(502);
    const unavailable = unavailableResponse(status, "cooling down", new Date(Date.now() + 60_000).toISOString(), "retry later");
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toMatchObject({ type: "server_error", code: "service_unavailable" });
  });

  it.each([400, 401, 403, 429, 499, 500, 502, 503, 504, "429"])("preserves effective failure status %s", (status) => {
    const result = createErrorResult(status, "upstream failed");
    expect(result.status).toBe(Number(status));
    expect(result.response.status).toBe(Number(status));
    expect(unavailableResponse(status, "cooling down", new Date().toISOString(), "retry later").status).toBe(Number(status));
  });
});
