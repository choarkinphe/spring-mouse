import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const GLM_CN_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GLM_QUOTA_RESPONSE = {
  data: {
    level: "coding",
    limits: [
      // The weekly reset can be sooner than the 5h reset near the week boundary.
      // `unit`, not reset order, identifies the bucket.
      { type: "TOKENS_LIMIT", unit: 6, number: 7, percentage: 25, nextResetTime: 1_800_000_000_000 },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40, nextResetTime: 1_800_014_400_000 },
    ],
  },
};

describe("GLM registry usage flags", () => {
  it("lists both international and China GLM for API-key quota tracking", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toEqual(expect.arrayContaining(["glm", "glm-cn"]));
    expect(USAGE_APIKEY_PROVIDERS).toEqual(expect.arrayContaining(["glm", "glm-cn"]));
  });
});

describe("getUsageForProvider(glm-cn)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps unit 3 and unit 6 limits to separate 5h and weekly quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(GLM_QUOTA_RESPONSE));

    const usage = await getUsageForProvider({
      provider: "glm-cn",
      apiKey: "glm-test-key",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Coding");
    expect(usage.quotas).toMatchObject({
      "Session (5h)": {
        used: 40,
        total: 100,
        remaining: 60,
        remainingPercentage: 60,
        resetAt: new Date(1_800_014_400_000).toISOString(),
      },
      "Weekly (7d)": {
        used: 25,
        total: 100,
        remaining: 75,
        remainingPercentage: 75,
        resetAt: new Date(1_800_000_000_000).toISOString(),
      },
    });

    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(GLM_CN_QUOTA_URL);
    expect(options.headers.Authorization).toBe("Bearer glm-test-key");
  });
});

describe("parseQuotaData(glm-cn)", () => {
  it("keeps both GLM quota rows for the channel-management dashboard", () => {
    const rows = parseQuotaData("glm-cn", {
      quotas: {
        "Session (5h)": { used: 40, total: 100, remainingPercentage: 60 },
        "Weekly (7d)": { used: 25, total: 100, remainingPercentage: 75 },
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({ name: "Session (5h)", used: 40, total: 100 }),
      expect.objectContaining({ name: "Weekly (7d)", used: 25, total: 100 }),
    ]);
  });
});
