import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("account fallback classification", () => {
  it.each([400, 406, 409, 413, 422])(
    "does not rotate accounts for client error %s",
    (status) => {
      expect(checkFallbackError(status, "invalid request")).toEqual({
        shouldFallback: false,
        cooldownMs: 0,
        modelLevel: false,
      });
    },
  );

  it("still rotates on an unmatched server error", () => {
    expect(checkFallbackError(503, "upstream unavailable")).toMatchObject({
      shouldFallback: true,
    });
  });
});

it("classifies provider overload as a model-level fallback without an account cooldown", () => {
  const result = checkFallbackError(503, "Our servers are currently overloaded", 8);
  expect(result).toEqual({ shouldFallback: true, cooldownMs: 0, modelLevel: true });
});
