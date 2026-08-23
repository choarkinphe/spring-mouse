import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkApiKeyQuota: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/lib/apiKeyQuota.js", () => ({
  checkApiKeyQuota: mocks.checkApiKeyQuota,
}));

const { authorizeApiKey } = await import("../../src/sse/services/auth.js");

describe("ingress API-key authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiKey.mockResolvedValue(true);
    mocks.checkApiKeyQuota.mockResolvedValue({ allowed: true });
  });

  it("rejects an invalid supplied key even when enforcement is off", async () => {
    mocks.validateApiKey.mockResolvedValueOnce(false);

    const response = await authorizeApiKey("sk-invalid", { requireApiKey: false });

    expect(response.status).toBe(401);
  });

  it("allows local keyless requests when enforcement is off", async () => {
    expect(await authorizeApiKey(null, { requireApiKey: false })).toBeNull();
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("enforces quota only after the key resolves successfully", async () => {
    expect(await authorizeApiKey("sk-valid", { requireApiKey: false })).toBeNull();

    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
    expect(mocks.checkApiKeyQuota).toHaveBeenCalledWith("sk-valid");
  });
});
