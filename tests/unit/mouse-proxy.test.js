import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { config } from "../../src/proxy.js";

describe("Mouse upload bypasses body-buffering Proxy", () => {
  it.each(["/api/mouses/tunnel/result", "/api/mouses/tunnel/result/", "/api/mouses/tunnel/result?probe=1"])("bypasses exactly %s", url => {
    expect(unstable_doesProxyMatch({ config, url })).toBe(false);
  });
  it.each(["/api/mouses", "/api/mouses/node/test", "/api/mouses/node/access-token", "/api/mouses/tunnel", "/api/mouses/tunnel/result-other", "/api/mouses/tunnel/result/child", "/api/settings", "/dashboard"])("preserves Proxy checks on %s", url => {
    expect(unstable_doesProxyMatch({ config, url })).toBe(true);
  });
});
