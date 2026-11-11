// Codex image IDs are local tool routes, not models returned by /codex/models.
export const CODEX_IMAGE_SUFFIX = "-image";

export function getCodexImageBaseModel(id) {
  return typeof id === "string" && id.endsWith(CODEX_IMAGE_SUFFIX)
    ? id.slice(0, -CODEX_IMAGE_SUFFIX.length)
    : null;
}

export function getCodexImageCandidates(snapshot, connectionId) {
  if (!connectionId || snapshot?.providerId !== "codex" || snapshot.status !== "success" || snapshot.source !== "official"
    || snapshot.scope !== "account" || snapshot.connectionId !== connectionId) return [];
  return [...new Set((snapshot.modelIds || []).map((entry) => typeof entry === "string" ? entry : entry?.id))]
    .filter((id) => typeof id === "string" && id.trim() && !id.endsWith(CODEX_IMAGE_SUFFIX) && !id.endsWith("-review"))
    .map((id) => ({ id: `${id}${CODEX_IMAGE_SUFFIX}`, baseModel: id }));
}
