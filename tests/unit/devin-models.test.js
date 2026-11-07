import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { encodeBytesField as b, encodeVarintField as v } from "../../open-sse/shared/devin/protobuf.js";
import { DEVIN_MODELS_PATH, normalizeDevinToken, parseDevinModels, resolveDevinModels, listDevinModelFamilies, resolveDevinModel } from "../../open-sse/services/devinModels.js";

const item = (id, label = id) => b(1, Buffer.concat([b(1, label), v(5, 1), v(18, 262144), b(22, id)]));

describe("Devin authenticated model directory", () => {
  it("retains exact wire UIDs, deduplicates and preserves official capabilities", () => {
    expect(parseDevinModels(Buffer.concat([item("swe-2-high", "SWE-2 High"), item("swe-2-high"), item("swe-2-low"), item("bad uid")]))).toEqual([
      expect.objectContaining({ id: "swe-2-high", name: "SWE-2 High", contextLength: 262144, isVL: true }),
      expect.objectContaining({ id: "swe-2-low", name: "swe-2-low", contextLength: 262144, isVL: true }),
    ]);
  });
  it("parses the pinned upstream Magpie binary without confusing free SWE with paid Lightning", () => {
    const payload = readFileSync(new URL("../fixtures/devin/magpie-model-configs-1015.bin", import.meta.url));
    const variants = parseDevinModels(payload);
    const models = listDevinModelFamilies(variants);
    expect(variants).toHaveLength(11);
    expect(models.find(m => m.id === "swe-2")).toMatchObject({ isFree: true, isVL: true, thinkingLevels: ["medium", "high", "max"], cost: { input: 0, output: 0 } });
    expect(models.find(m => m.id === "swe-2-lightning")).toMatchObject({ cost: { input: 1, cacheRead: 0.1, output: 5 } });
    expect(models.find(m => m.id === "swe-2-lightning").isFree).toBeUndefined();
  });
  it("normalizes JWTs only once without inventing expiry", () => {
    expect(normalizeDevinToken(" eyJ.test ")).toBe("devin-session-token$eyJ.test");
    expect(normalizeDevinToken("devin-session-token$eyJ.test")).toBe("devin-session-token$eyJ.test");
    expect(normalizeDevinToken("cog_test")).toBe("cog_test");
  });
  it("fetches unary protobuf through the selected proxy without forwarding tokens to custom hosts", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(item("swe-2-high")));
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:8080" };
    const result = await resolveDevinModels({ accessToken: "eyJ.test", providerSpecificData: { baseUrl: "https://untrusted.invalid" } }, { fetchFn, proxyOptions });
    expect(result.models[0].id).toBe("swe-2-high");
    expect(result.listingScope).toBe("account");
    const [url, options, proxy] = fetchFn.mock.calls[0];
    expect(url).toBe(`https://server.codeium.com${DEVIN_MODELS_PATH}`);
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.body.includes(Buffer.from("devin-session-token$eyJ.test"))).toBe(true);
    expect(options.headers["Content-Type"]).toBe("application/proto");
    expect(options.headers["Sentry-Trace"]).toBeUndefined();
    expect(options.redirect).toBe("error");
    expect(proxy).toBe(proxyOptions);
  });
  it("does not call upstream without credentials", async () => {
    const fetchFn = vi.fn();
    expect((await resolveDevinModels({}, { fetchFn })).status).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("preserves auth/rate-limit status without exposing raw upstream diagnostics", async () => {
    for (const status of [401, 403, 429]) {
      const fetchFn = vi.fn().mockResolvedValue(new Response("secret-token", { status }));
      const result = await resolveDevinModels({ accessToken: "test-token" }, { fetchFn });
      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain("secret-token");
    }
  });
  it("fails closed for empty or malformed catalogs without static fallback", async () => {
    for (const payload of [new Uint8Array(), Uint8Array.of(10, 99, 1)]) {
      const result = await resolveDevinModels({ accessToken: "test-token" }, { fetchFn: async () => new Response(payload) });
      expect(result.models).toEqual([]);
      expect(result.status).toBe(502);
    }
  });
  it("uses official family metadata for family, effort tiers, free models and output limits", async () => {
    const variant = (id, costTier) => b(1, Buffer.concat([b(1, id), b(22, id), v(5, 1), v(18, 262144), b(23, Buffer.concat([v(13, 128000), b(23, "swe-2")])), b(30, b(1, "SWE-2")), v(24, costTier)]));
    const payload = Buffer.concat([variant("swe-2-high", 4), variant("swe-2-medium", 4), variant("swe-2-high-lightning", 3)]);
    const models = parseDevinModels(payload);
    const families = listDevinModelFamilies(models);
    expect(families.find(m => m.id === "swe-2")).toMatchObject({ name: "SWE-2", thinkingLevels: ["medium", "high"], isFree: true, maxOutputTokens: 128000 });
    expect(families.find(m => m.id === "swe-2-lightning").isFree).toBeUndefined();
    const creds = { accessToken: "family-fixture-token" };
    const fetchFn = vi.fn().mockResolvedValue(new Response(payload));
    await resolveDevinModels(creds, { fetchFn });
    expect(await resolveDevinModel({ credentials: creds, model: "swe-2", effort: "low" })).toBe("swe-2-medium");
    expect(await resolveDevinModel({ credentials: creds, model: "swe-2", effort: "high" })).toBe("swe-2-high");
    expect(await resolveDevinModel({ credentials: creds, model: "swe-2-lightning", effort: "high" })).toBe("swe-2-high-lightning");
    expect(await resolveDevinModel({ credentials: {}, model: "swe-2-medium" })).toBe("swe-2-medium");
  });
  it("bounds the catalog size", async () => {
    const result = await resolveDevinModels({ accessToken: "test-token" }, { fetchFn: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) });
    expect(result.status).toBe(502);
  });
});
