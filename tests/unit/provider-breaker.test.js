import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ eval: vi.fn(), get: vi.fn(), pTTL: vi.fn(), del: vi.fn(async () => 1) }));
vi.mock("../../src/lib/redis/routingClient.js", () => ({
  routingRedis: async (fn) => fn(mocks),
}));

const breaker = await import("../../src/sse/services/providerBreaker.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eval.mockResolvedValue(0);
  mocks.get.mockResolvedValue(null);
  mocks.pTTL.mockResolvedValue(-2);
});

describe("provider/model breaker", () => {
  it("opens after three consecutive failures", async () => {
    expect(await breaker.recordProviderModelFailure("p", "m")).toEqual({ open: false });
    expect(await breaker.recordProviderModelFailure("p", "m")).toEqual({ open: false });
    mocks.eval.mockResolvedValueOnce(1);
    expect(await breaker.recordProviderModelFailure("p", "m")).toMatchObject({ open: true });

    mocks.get.mockResolvedValueOnce('{"until":1}');
    mocks.pTTL.mockResolvedValueOnce(45_000);
    await expect(breaker.getProviderModelBreaker("p", "m")).resolves.toMatchObject({ open: true });
  });

  it("keeps different models isolated", async () => {
    await breaker.recordProviderModelFailure("p", "other");
    expect(mocks.eval.mock.calls[0][1].arguments[1]).toBe("3");
  });
});
