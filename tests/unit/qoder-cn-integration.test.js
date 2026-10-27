import { describe, expect, it } from "vitest";
import cn from "../../open-sse/providers/registry/qoder-cn.js";
import global from "../../open-sse/providers/registry/qoder.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import qoderOAuth from "../../src/lib/oauth/providers/qoder.js";

const cnConfig = cn.oauth;

describe("Qoder regional integration", () => {
  it("registers an independent CN identity, catalog and trusted endpoints", () => {
    expect(cn.id).toBe("qoder-cn");
    expect(cn.alias).not.toBe(global.alias);
    expect(PROVIDER_MODELS.qdcn.map((m) => m.id)).toContain("auto");
    expect(cn.oauth.openApiBaseUrl).toBe("https://openapi.qoder.com.cn");
    expect(cn.transport.baseUrl).toMatch(/^https:\/\/gateway\.qoder\.com\.cn\//);
    expect(cn.transport.usage.url).toBe("https://openapi.qoder.com.cn/sash/api/v2/me/usage");
    expect(getExecutor("qoder-cn")).not.toBe(getExecutor("qoder"));
  });

  it("starts device authorization in CN and stores its region", async () => {
    const flow = await qoderOAuth.requestDeviceCode(cnConfig);
    expect(new URL(flow.verification_uri_complete).hostname).toBe("qoder.cn");
    const mapped = qoderOAuth.mapTokens({ access_token: "dt-test", _qoderRegion: "cn" });
    expect(mapped.providerSpecificData.region).toBe("cn");
    expect(qoderOAuth.mapTokens({ access_token: "dt-test" }).providerSpecificData.region).toBe("global");
  });
});
