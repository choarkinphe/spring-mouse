import { CODEX_NATIVE_IMAGE_MODEL } from "open-sse/config/codexImage.js";

// Kept only to identify persisted legacy chat-model image aliases.
export const CODEX_IMAGE_SUFFIX = "-image";

export function getCodexImageBaseModel(id) {
  if (id === CODEX_NATIVE_IMAGE_MODEL) return id;
  return typeof id === "string" && id.endsWith(CODEX_IMAGE_SUFFIX)
    ? id.slice(0, -CODEX_IMAGE_SUFFIX.length)
    : null;
}

// The native Images API is independent of /codex/models. A chat directory
// snapshot neither grants nor denies image access; the selected account must
// be tested against the Images API to establish its current entitlement.
export function getCodexImageCandidates(_snapshot, connectionId) {
  if (typeof connectionId !== "string" || !connectionId.trim()) return [];
  return [{ id: CODEX_NATIVE_IMAGE_MODEL, baseModel: CODEX_NATIVE_IMAGE_MODEL }];
}
