import { describe, it, expect } from "vitest";
import { detectRequiredCapabilities, getComboCapabilityValidationError, getComboModelsForRequest, getUnsupportedComboRequestCapability } from "../../open-sse/services/combo.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Hermes Vision Image Detection", () => {
  it("detects vision from Ollama / Hermes images array", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Please analyze this image from Hermes",
          images: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="],
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("detects vision from Vercel AI SDK / Hermes experimental_attachments", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Describe this attachment",
          experimental_attachments: [
            {
              contentType: "image/png",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          ],
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("detects vision from Hermes attachments array", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Look at this photo",
          attachments: [
            {
              mediaType: "image/jpeg",
              url: "https://example.com/photo.jpg",
            },
          ],
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("detects vision from embedded data:image URI in string content", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Here is an inline image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    };
    const caps = detectRequiredCapabilities(body);
    expect(caps.has("vision")).toBe(true);
  });

  it("uses a combo's own vision/audio-capable member instead of a global fallback pool", () => {
    const body = {
      messages: [{ role: "user", content: "Analyze image and audio", images: ["base64data..."] }],
    };
    const reqCaps = detectRequiredCapabilities(body);
    reqCaps.add("audioInput");
    const models = ["cmc/deepseek/deepseek-v4-pro", "oc/mimo-v2.5-free"];
    const capabilities = { contextWindow: 1048576, vision: true, audioInput: true };

    expect(getComboCapabilityValidationError(models, capabilities)).toBeNull();
    expect(getComboModelsForRequest(models, reqCaps, capabilities)).toEqual(["oc/mimo-v2.5-free"]);
  });

  it("rejects a declared vision capability without a capable combo member", () => {
    const models = ["cmc/deepseek/deepseek-v4-pro"];
    expect(getComboCapabilityValidationError(models, { vision: true, audioInput: false })).toMatch("视觉");
    expect(getUnsupportedComboRequestCapability(new Set(["vision"]), { vision: false, audioInput: false })).toBe("视觉");
  });

  it("strips msg.images and attachments when model does not support vision", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Test text",
          images: ["base64..."],
          experimental_attachments: [{ contentType: "image/png", url: "data:image/png;base64,..." }],
        },
      ],
    };
    const noVisionCaps = { vision: false, pdf: false, audioInput: false };

    stripUnsupportedModalities(body, FORMATS.OPENAI, noVisionCaps);

    expect(body.messages[0].images).toBeUndefined();
    expect(body.messages[0].experimental_attachments).toHaveLength(0);
  });
});
