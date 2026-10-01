import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildHarnessModelHints } from "@/shared/utils/harnessModels";
import { resolveHarnessModelOptions } from "@/shared/utils/harnessRoute";

vi.mock("@/lib/db/index.js", () => ({ getCustomModels: vi.fn(async () => [{ id: "gpt-6.1-sol" }]) }));
vi.mock("@/shared/utils/modelCatalog", async (importOriginal) => ({
  ...await importOriginal(), fetchModelsDevCatalog: vi.fn(),
}));
import { fetchModelsDevCatalog } from "@/shared/utils/modelCatalog";
import { GET } from "@/app/api/harnesses/models/route.js";

beforeEach(() => fetchModelsDevCatalog.mockReset());

describe("harness completion vocabulary", () => {
  it("includes Fable offline and merges newer Claude/GPT ids first within a family", () => {
    const models = buildHarnessModelHints({
      claude: [{ id: "claude-opus-5-10" }, { id: "claude-fable-6" }],
      codex: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-sol" }],
      local: [{ id: "anthropic/claude-opus-5-10" }, { id: "gpt-6.1-sol" }],
    });
    expect(models["claude-code"]).toContain("claude-fable-5-1");
    expect(models["claude-code"]).toContain("claude-sonnet-5-5");
    expect(models["claude-code"].indexOf("claude-opus-5-10"))
      .toBeLessThan(models["claude-code"].indexOf("claude-opus-5-5"));
    expect(models.codex.slice(0, 2)).toEqual(["gpt-6.1-sol", "gpt-6-sol"]);
    expect(models.codex.filter((id) => id === "gpt-6.1-sol")).toHaveLength(1);
    expect(models["claude-desktop"]).toEqual(models["claude-code"]);
  });

  it("filters invalid, wildcard, unknown namespace and non-LLM models", () => {
    const models = buildHarnessModelHints({ local: [
      { id: "gpt-6-image" }, { id: "gpt-6-audio" }, { id: "gpt-realtime" },
      { id: "gpt-6", type: "image" }, { id: "gpt-6-tool", kind: "tts" },
      { id: "random/gpt-6" }, { id: "claude-*" }, { id: "has space" },
      { id: "openai/gpt-6.2" }, { id: "anthropic/claude-fable-6" },
    ] });
    expect(models.codex).toContain("gpt-6.2");
    expect(models.codex).not.toContain("gpt-6");
    expect(models.codex.some((id) => /image|audio|realtime|tool|\//.test(id))).toBe(false);
    expect(models["claude-code"]).toContain("claude-fable-6");
    expect(models["claude-code"]).not.toContain("claude-*");
  });

  it("retains arbitrary custom hints without duplicating discovered ids", () => {
    const models = resolveHarnessModelOptions("codex", { codex: ["private-model", "gpt-6"] }, ["gpt-6"]);
    expect(models[0]).toBe("gpt-6");
    expect(models).toContain("private-model");
    expect(models.filter((id) => id === "gpt-6")).toHaveLength(1);
  });

  it("uses public vocabulary when available and passes a bounded fetch adapter", async () => {
    fetchModelsDevCatalog.mockResolvedValue({
      anthropic: { models: { latest: { id: "claude-fable-6" } } },
      openai: { models: { latest: { id: "gpt-6.2" } } },
    });
    const data = await (await GET()).json();
    expect(data.models["claude-code"]).toContain("claude-fable-6");
    expect(data.models.codex).toContain("gpt-6.2");
    expect(data.sources.codex).toBe("catalog");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });
    await fetchModelsDevCatalog.mock.calls[0][0].fetchImpl("https://models.dev/api.json", {});
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockRestore();
  });

  it("falls back to local synchronized ids and offline Fable when catalog is unavailable", async () => {
    fetchModelsDevCatalog.mockResolvedValue(null);
    const response = await GET();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.sources["claude-code"]).toBe("local");
    expect(data.models["claude-code"]).toContain("claude-fable-5");
    expect(data.models.codex).toContain("gpt-6.1-sol");
  });
});
