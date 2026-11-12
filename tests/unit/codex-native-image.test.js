import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { CODEX_NATIVE_IMAGE_MODEL, CODEX_NATIVE_IMAGE_URL, CODEX_IMAGE_CLIENT_VERSION } from "open-sse/config/codexImage.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
const request = (extra = {}) => ({ body: { prompt: "A small mouse", n: 1, size: "1024x1024", response_format: "b64_json" }, modelInfo: { provider: "codex", model: CODEX_NATIVE_IMAGE_MODEL }, credentials: { accessToken: "test-only", providerSpecificData: { chatgptAccountId: "chosen-account" } }, ...extra });
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => Response.json({ created: 123, data: [{ b64_json: image, generation_id: "fixture" }], output_format: "png", size: "1024x1024" }))); });
afterEach(() => vi.unstubAllGlobals());
describe("Codex native image generation", () => {
  it("uses the native Images API and the selected OAuth account", async () => {
    const success = vi.fn();
    const result = await handleImageGenerationCore(request({ onRequestSuccess: success }));
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith(CODEX_NATIVE_IMAGE_URL, expect.objectContaining({ headers: expect.objectContaining({ accept: "application/json", authorization: "Bearer test-only", "chatgpt-account-id": "chosen-account", version: CODEX_IMAGE_CLIENT_VERSION, "x-codex-imagegen-request-id": expect.any(String), "x-codex-image-turn-id": expect.any(String) }) }));
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent).toEqual({ model: CODEX_NATIVE_IMAGE_MODEL, prompt: "A small mouse", n: 1, size: "1024x1024" });
    expect((await result.response.json()).data[0]).toEqual({ b64_json: image, generation_id: "fixture" });
    expect(success).toHaveBeenCalledOnce();
  });
  it("returns JSON even when a legacy client requests SSE", async () => {
    const result = await handleImageGenerationCore(request({ streamToClient: true }));
    expect(result.response.headers.get("content-type")).toBe("application/json");
    expect((await result.response.json()).data[0].b64_json).toBe(image);
  });
  it("supports binary output", async () => {
    const result = await handleImageGenerationCore(request({ binaryOutput: true }));
    expect(result.response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await result.response.arrayBuffer()).toString("base64")).toBe(image);
  });
  it("forwards only native image options and ignores Responses fields", async () => {
    const result = await handleImageGenerationCore(request({ body: { prompt: "test", quality: "low", background: "opaque", output_format: "png", tools: [], stream: true, reasoning: {}, response_format: "b64_json" } }));
    expect(result.success).toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ model: CODEX_NATIVE_IMAGE_MODEL, prompt: "test", n: 1, quality: "low", background: "opaque", output_format: "png" });
  });
  it.each([{ image: "data:image/png;base64,AA==" }, { images: ["https://example.com/ref.png"] }, { mask: "mask" }])("rejects reference input instead of silently ignoring it: %j", async (refs) => {
    const result = await handleImageGenerationCore(request({ body: { prompt: "test", ...refs } }));
    expect(result.status).toBe(400); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{}, { data: [] }, { data: [{}] }, { data: [{ b64_json: "" }] }])("does not report empty successful responses as images: %j", async (body) => {
    fetch.mockResolvedValueOnce(Response.json(body));
    const success = vi.fn(); const result = await handleImageGenerationCore(request({ onRequestSuccess: success }));
    expect(result.success).toBe(false); expect(result.status).toBe(502); expect(success).not.toHaveBeenCalled();
  });
  it("propagates request cancellation to native fetch", async () => {
    const controller = new AbortController();
    await handleImageGenerationCore(request({ signal: controller.signal }));
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it("exposes the native image model as image, not chat or edit", () => {
    expect(getModelsByProviderId("codex").find(m => m.id === CODEX_NATIVE_IMAGE_MODEL)).toMatchObject({ kind: "image", capabilities: ["text2img"] });
  });
});
