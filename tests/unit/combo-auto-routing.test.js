import { describe, expect, it, vi } from "vitest";

import {
  buildAutoClassifierRequest,
  classifyAutoRequest,
  getAutoRoutingSignals,
  normalizeAutoRoutingConfig,
  parseAutoClassifierOutput,
  reorderByAutoLevel,
} from "../../open-sse/services/autoRouting.js";
import { normalizeComboModelsForStorage } from "../../open-sse/services/combo.js";

describe("combo auto routing", () => {
  it("normalizes auto tiers and keeps legacy strings compatible", () => {
    expect(normalizeComboModelsForStorage([
      "fast/model",
      { model: "strong/model", autoTier: "strong", accessTags: ["team"] },
      { model: "bad-tier/model", autoTier: "unknown" },
    ])).toEqual([
      "fast/model",
      { model: "strong/model", accessTags: ["team"], autoTier: "strong" },
      "bad-tier/model",
    ]);
  });

  it("orders entries by complexity level without dropping fallback nodes", () => {
    const entries = [
      { model: "fast/model", autoTier: "fast" },
      { model: "balanced/model", autoTier: "balanced" },
      { model: "strong/model", autoTier: "strong" },
    ];
    expect(reorderByAutoLevel(entries, "simple").map((entry) => entry.model)).toEqual([
      "fast/model", "balanced/model", "strong/model",
    ]);
    expect(reorderByAutoLevel(entries, "complex").map((entry) => entry.model)).toEqual([
      "strong/model", "balanced/model", "fast/model",
    ]);
  });

  it("raises the default level for deterministic hard signals", () => {
    const body = {
      messages: [{ role: "user", content: "use the tools" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
    };
    const signals = getAutoRoutingSignals(body, new Set());
    const config = normalizeAutoRoutingConfig({ defaultLevel: "simple" });
    expect(config.minimumLevel.hasTools).toBe("standard");
    expect(buildAutoClassifierRequest(body, config).messages[1].content).toContain("hasTools");
    expect(signals.hasTools).toBe(true);
  });

  it("accepts only the constrained classifier JSON shape", () => {
    expect(parseAutoClassifierOutput({ choices: [{ message: { content: '{"level":"complex","confidence":0.9}' } }] }))
      .toEqual({ level: "complex", confidence: 0.9 });
    expect(parseAutoClassifierOutput('{"level":"complex","confidence":2}')).toBeNull();
    expect(parseAutoClassifierOutput("not-json")).toBeNull();
  });

  it("fails open on low confidence and preserves the original body", async () => {
    const body = {
      model: "route",
      stream: true,
      tools: [{ type: "function", function: { name: "lookup" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "keep this" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }],
    };
    const before = structuredClone(body);
    const response = await classifyAutoRequest({
      body,
      config: { classifierModel: "cheap/model", minConfidence: 0.8 },
      requiredCapabilities: new Set(["vision"]),
      callModel: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"level":"complex","confidence":0.4}' } }] }), { status: 200 })),
    });
    expect(response.level).toBe("standard");
    expect(response.source).toBe("default");
    expect(body).toEqual(before);
  });

  it("uses the default when the classifier times out", async () => {
    const response = await classifyAutoRequest({
      body: { messages: [{ role: "user", content: "hello" }] },
      config: { classifierModel: "cheap/model", classifierTimeoutMs: 5 },
      requiredCapabilities: new Set(),
      callModel: () => new Promise(() => {}),
    });
    expect(response).toMatchObject({ level: "standard", source: "default" });
  });
});
