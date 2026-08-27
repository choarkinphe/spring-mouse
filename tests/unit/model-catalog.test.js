import { describe, expect, it } from "vitest";
import {
  capabilitiesFromModelsDev,
  parseModelsDevCatalog,
} from "../../src/shared/utils/modelCatalog.js";

describe("models.dev catalog normalization", () => {
  it("maps multimodal inputs and token limits into Spring Mouse capabilities", () => {
    expect(capabilitiesFromModelsDev({
      reasoning: true,
      tool_call: true,
      modalities: {
        input: ["text", "image", "video", "pdf"],
        output: ["text"],
      },
      limit: { context: 1_000_000, output: 131_072 },
    })).toEqual({
      vision: true,
      pdf: true,
      audioInput: false,
      videoInput: true,
      imageOutput: false,
      audioOutput: false,
      tools: true,
      reasoning: true,
      contextWindow: 1_000_000,
      maxOutput: 131_072,
    });
  });

  it("extracts and sorts a configured provider catalog", () => {
    const models = parseModelsDevCatalog({
      "zhipuai-coding-plan": {
        models: {
          "glm-5.3": {
            id: "glm-5.3",
            name: "GLM-5.3",
            release_date: "2026-08-14",
            modalities: { input: ["text"], output: ["text"] },
          },
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            release_date: "2026-08-26",
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    }, "zhipuai-coding-plan");

    expect(models.map((model) => model.id)).toEqual(["glm-5.3-flash", "glm-5.3"]);
    expect(models[0].capabilities).toMatchObject({ vision: true, pdf: true, reasoning: true });
  });
});
