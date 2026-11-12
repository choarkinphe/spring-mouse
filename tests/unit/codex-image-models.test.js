import { describe, it, expect } from "vitest";
import { getCodexImageBaseModel, getCodexImageCandidates } from "@/shared/utils/codexImageModels";

const nativeChoice = [{ id: "gpt-image-2", baseModel: "gpt-image-2" }];
const snapshot = { providerId: "codex", status: "success", source: "official", scope: "account", connectionId: "a", modelIds: ["actual-model", "actual-model-review", "fabricated-image"] };

describe("Codex image model candidates", () => {
  it("offers the native image model without any chat directory snapshot", () => {
    expect(getCodexImageCandidates(undefined, "a")).toEqual(nativeChoice);
    expect(getCodexImageCandidates(null, "a")).toEqual(nativeChoice);
  });
  it.each([undefined, null, "", "   "])("requires a selected account: %j", (connectionId) => {
    expect(getCodexImageCandidates(snapshot, connectionId)).toEqual([]);
  });
  it("does not infer image entitlement or models from a chat directory", () => {
    expect(getCodexImageCandidates(snapshot, "a")).toEqual(nativeChoice);
    expect(getCodexImageCandidates(snapshot, "b")).toEqual(nativeChoice);
    expect(getCodexImageCandidates({ ...snapshot, status: "failed", modelIds: [] }, "a")).toEqual(nativeChoice);
  });
  it("never offers fabricated image IDs or legacy chat-image aliases", () => {
    const ids = getCodexImageCandidates(snapshot, "a").map((model) => model.id);
    expect(ids).not.toContain("fabricated-image");
    expect(ids).not.toContain("actual-model-image");
  });
  it("recognizes native image IDs and preserves legacy suffix parsing", () => {
    expect(getCodexImageBaseModel("gpt-image-2")).toBe("gpt-image-2");
    expect(getCodexImageBaseModel("actual-model-image")).toBe("actual-model");
    expect(getCodexImageBaseModel("actual-model-image-image")).toBe("actual-model-image");
    expect(getCodexImageBaseModel("actual-model")).toBeNull();
    expect(getCodexImageBaseModel(null)).toBeNull();
  });
});