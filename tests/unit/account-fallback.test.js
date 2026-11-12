import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("account fallback classification", () => {
  it("rotates on an empty upstream reply without locking the account", () => {
    const raw = '{"error":{"message":"An empty reply (Devin returned no text, reasoning or tool call)","type":"upstream_error","code":"empty_stream"}}';
    expect(checkFallbackError(502, raw)).toEqual({ shouldFallback: true, cooldownMs: 0, modelLevel: true });
  });
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

  it.each([
    'model [gpt-6.1-sol] is not allowed for user type [personal_free_user]',
    'Your account type does not support this model.',
    '[400]: {"code":11158,"msg":"model [gpt-6.1-sol] is not allowed for user type [personal_free_user]"}',
    { error: { message: 'Your account type does not support this model.' } },
  ])("rotates on an explicit account/model entitlement rejection: %j", (error) => {
    expect(checkFallbackError(400, error)).toEqual({
      shouldFallback: true, cooldownMs: 120_000, modelLevel: false,
    });
  });

  it.each([
    '{"code":11158,"msg":"invalid request"}',
    'Unsupported parameter: reasoning_effort',
    'context_length_exceeded',
    'model is not allowed in this request',
  ])("keeps unrelated HTTP 400 errors terminal: %s", (error) => {
    expect(checkFallbackError(400, error).shouldFallback).toBe(false);
  });

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
