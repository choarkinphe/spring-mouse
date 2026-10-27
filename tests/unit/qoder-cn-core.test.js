import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => globalThis.fetch(...args) }));
import { QoderService } from "../../src/lib/oauth/services/qoder.js";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";
import { resolveQoderCredentials, resolveQoderModels, clearQoderCatalog, refreshQoderToken } from "../../open-sse/services/qoderModels.js";

afterEach(() => { vi.unstubAllGlobals(); clearQoderCatalog(); });

describe("Qoder region isolation", () => {
  it("creates the CN device flow without a redirect", () => {
    const flow = new QoderService("cn").initiateDeviceFlow();
    const url = new URL(flow.verificationUriComplete);
    expect(url.origin).toBe("https://qoder.cn");
    expect(url.searchParams.get("client_id")).toBe("e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb");
    expect(url.searchParams.has("redirect_uri")).toBe(false);
    expect(() => new QoderService("invalid")).toThrow();
  });
  it("polls and retrieves user info only from CN openapi", async () => {
    const fetch = vi.fn(async (url) => String(url).includes("poll")
      ? Response.json({ token: "dt-test", user_id: "user" })
      : Response.json({ name: "Test" }));
    vi.stubGlobal("fetch", fetch);
    const service = new QoderService("cn");
    await service.pollDeviceToken({ nonce: "n", codeVerifier: "v" });
    await service.fetchUserInfo("dt-test");
    expect(fetch.mock.calls.every(([url, options]) => String(url).startsWith("https://openapi.qoder.com.cn/") && options.redirect === "error")).toBe(true);
  });
  it("rejects conflicting credentials before network access", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const executor = new QoderExecutor("qoder-cn");
    await expect(executor.execute({ credentials: { apiKey: "pt-test", providerSpecificData: { region: "global" } } })).rejects.toThrow(/region/);
    await expect(new QoderExecutor("qoder").execute({ credentials: { apiKey: "pt-test", providerSpecificData: { region: "cn" } } })).rejects.toThrow(/region/);
    expect(fetch).not.toHaveBeenCalled();
    expect(executor.buildUrl({ accessToken: "jt-test" })).toMatch(/^https:\/\/gateway\.qoder\.com\.cn\//);
  });
  it("refreshes CN device and job tokens at their respective endpoints", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "new-token", refresh_token: "new-refresh", expires_in: 10000 }));
    vi.stubGlobal("fetch", fetch);
    for (const [token, path] of [["dt-old", "deviceToken"], ["jt-old", "jobToken"]]) {
      const result = await refreshQoderToken({ accessToken: token, refreshToken: "refresh", providerSpecificData: { region: "cn" } });
      expect(result).toMatchObject({ accessToken: "new-token", refreshToken: "new-refresh", expiresIn: 10 });
      expect(fetch.mock.calls.at(-1)[0]).toBe(`https://openapi.qoder.com.cn/api/v1/${path}/refresh`);
    }
  });
  it("isolates PAT exchanges and catalogs across regions and accounts", async () => {
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      requests.push(String(url));
      if (String(url).includes("jobToken/exchange")) return Response.json({ token: "jt-test", expires_in: 86400000 });
      if (String(url).includes("userinfo")) return Response.json({ id: "same-user" });
      if (String(url).includes("model/list")) return Response.json({ chat: [{ key: String(url).includes(".com.cn") ? "cn-model" : "global-model" }] });
      throw new Error(`unexpected ${url}`);
    }));
    const make = (region, token = "pt-regional-test") => ({ apiKey: token, providerSpecificData: { region } });
    const cn = make("cn"); const global = make("global");
    expect((await resolveQoderCredentials(cn)).providerSpecificData.region).toBe("cn");
    const cnModels = await resolveQoderModels(cn);
    const globalModels = await resolveQoderModels(global);
    expect(cnModels.models[0].id).toBe("cn-model");
    expect(globalModels.models[0].id).toBe("global-model");
    await resolveQoderModels(make("cn", "pt-other-account"));
    expect(requests.filter(x => x.includes("jobToken/exchange"))).toHaveLength(3);
    expect(requests.filter(x => x.includes("model/list"))).toHaveLength(3);
    expect(requests.some(x => x.startsWith("https://openapi.qoder.com.cn/"))).toBe(true);
    expect(requests.some(x => x.startsWith("https://openapi.qoder.sh/"))).toBe(true);
  });
});
