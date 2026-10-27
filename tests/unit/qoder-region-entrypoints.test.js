import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => Response.json(body, init) } }));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => globalThis.fetch(...args) }));

import { POST } from "../../src/app/api/providers/validate/route.js";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";
import { discoverConnectionModels } from "../../src/lib/services/officialModelDiscovery.js";
import { requestDeviceCode, pollForToken } from "../../src/lib/oauth/providers/index.js";
import { getProviderConnectionById } from "@/lib/localDb";
import { withQoderProviderRegion } from "../../open-sse/shared/qoder/constants.js";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe.each([["qoder", "cn"], ["qoder-cn", "global"]])("%s rejects region %s", (provider, region) => {
  it("rejects validation, saved probes, discovery and OAuth before networking", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const connection = { id: "isolated", provider, apiKey: "pt-fixture", accessToken: "dt-fixture", providerSpecificData: { region } };
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(connection),
    }));
    expect((await response.json()).valid).toBe(false);
    for (const authType of ["apikey", "oauth"]) {
      getProviderConnectionById.mockResolvedValue({ ...connection, authType });
      expect((await testSingleConnection("isolated")).valid).toBe(false);
    }
    expect((await discoverConnectionModels(connection)).error).toMatch(/region/);
    await expect(requestDeviceCode(provider, undefined, { region })).rejects.toThrow(/region/);
    await expect(pollForToken(provider, "nonce", "verifier", { region })).rejects.toThrow(/region/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("fills only missing regions and rejects invalid explicit values", () => {
  expect(withQoderProviderRegion("qoder", {})).toEqual({ region: "global" });
  expect(withQoderProviderRegion("qoder-cn", {})).toEqual({ region: "cn" });
  expect(() => withQoderProviderRegion("qoder", { region: null })).toThrow(/region/);
});
