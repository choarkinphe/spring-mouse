import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetchImage: vi.fn() }));
vi.mock("open-sse/translator/concerns/image.js", async (importOriginal) => ({ ...(await importOriginal()), fetchImageAsBase64: mocks.fetchImage }));
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const generate = (body = {}, onRequestSuccess) => handleImageGenerationCore({ body: { prompt: "fixture", ...body }, modelInfo: { provider: "corecode", model: "gpt-image-2.5-sunburst" }, credentials: { apiKey: "fake" }, onRequestSuccess });
beforeEach(() => { vi.clearAllMocks(); mocks.fetchImage.mockResolvedValue({ url: `data:image/png;base64,${png}`, mimeType: "image/png" }); });
afterEach(() => vi.unstubAllGlobals());
function upstream(data) { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ created: 1, data, usage: { total_tokens: 3 } }))); }
describe("CoreCode image response compatibility", () => {
  it.each([{}, { response_format: "b64_json" }])("converts URL output to base64 for %j", async (body) => {
    upstream([{ url: "https://images.example/temporary", revised_prompt: "updated" }]);
    const success = vi.fn(); const result = await generate(body, success); const json = await result.response.json();
    expect(result.success).toBe(true); expect(json.data[0]).toMatchObject({ url: "https://images.example/temporary", b64_json: png, revised_prompt: "updated" });
    expect(json.usage.total_tokens).toBe(3); expect(mocks.fetchImage).toHaveBeenCalledWith("https://images.example/temporary", expect.any(Object)); expect(success).toHaveBeenCalledOnce();
  });
  it("retains explicit URL output without downloading", async () => { upstream([{ url: "https://images.example/temporary" }]); const r = await generate({ response_format: "url" }); expect((await r.response.json()).data[0]).toEqual({ url: "https://images.example/temporary" }); expect(mocks.fetchImage).not.toHaveBeenCalled(); });
  it("keeps existing base64 without a URL fetch", async () => { upstream([{ b64_json: png }]); const r = await generate(); expect((await r.response.json()).data[0].b64_json).toBe(png); expect(mocks.fetchImage).not.toHaveBeenCalled(); });
  it("converts all images, not just the first", async () => { upstream([{ url: "https://images.example/a" }, { url: "https://images.example/b" }]); const r = await generate(); expect((await r.response.json()).data.map(x => x.b64_json)).toEqual([png,png]); expect(mocks.fetchImage).toHaveBeenCalledTimes(2); });
  it("returns 502 without leaking URLs when fetching fails", async () => { upstream([{ url: "http://127.0.0.1/secret" }]); mocks.fetchImage.mockResolvedValue(null); const success = vi.fn(); const r = await generate({}, success); expect(r.success).toBe(false); expect(r.status).toBe(502); expect(r.error).not.toContain("127.0.0.1"); expect(success).not.toHaveBeenCalled(); });
  it.each([[], [{}]])("rejects missing image data %j", async data => { upstream(data); const r = await generate(); expect(r.success).toBe(false); expect(r.status).toBe(502); });
});
