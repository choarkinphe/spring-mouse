import { describe, it, expect } from "vitest";
import { getCodexImageBaseModel, getCodexImageCandidates } from "@/shared/utils/codexImageModels";

const snapshot = { providerId: "codex", status: "success", source: "official", scope: "account", connectionId: "a", modelIds: ["actual-model", "actual-model", "actual-model-review", "old-image"] };
describe("Codex image model candidates", () => {
  it("uses real directory IDs, not the built-in image list", () => {
    expect(getCodexImageCandidates(snapshot, "a")).toEqual([{ id: "actual-model-image", baseModel: "actual-model" }]);
  });
  it("never borrows a different account's directory", () => {
    expect(getCodexImageCandidates(snapshot, "b")).toEqual([]);
    expect(getCodexImageCandidates(snapshot, "")).toEqual([]);
  });
  it.each([{ source: "static" }, { status: "failed" }, { scope: "public" }, { providerId: "openai" }])("rejects non-account official evidence: %j", (override) => {
    expect(getCodexImageCandidates({ ...snapshot, ...override }, "a")).toEqual([]);
  });
  it("strips only one terminal image suffix", () => {
    expect(getCodexImageBaseModel("actual-model-image")).toBe("actual-model");
    expect(getCodexImageBaseModel("actual-model")).toBeNull();
  });
});
