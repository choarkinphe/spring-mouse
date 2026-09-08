const MAX_ACCESS_TAGS = 20;
const MAX_ACCESS_TAG_LENGTH = 40;

export function normalizeAccessTags(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，\n]/)
      : [];

  return [...new Set(raw
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .map((tag) => tag.slice(0, MAX_ACCESS_TAG_LENGTH)))]
    .slice(0, MAX_ACCESS_TAGS);
}

export function hasAccessTagOverlap(leftTags, rightTags) {
  const left = new Set(normalizeAccessTags(leftTags));
  if (left.size === 0) return false;
  return normalizeAccessTags(rightTags).some((tag) => left.has(tag));
}

export function canAccessWithTags(subjectTags, resourceTags) {
  const required = normalizeAccessTags(resourceTags);
  if (required.length === 0) return true;
  return hasAccessTagOverlap(subjectTags, required);
}

export function getModelAccessTags(modelAccessTags, ...modelIds) {
  if (!modelAccessTags || typeof modelAccessTags !== "object") return [];
  for (const modelId of modelIds) {
    if (typeof modelId !== "string" || !modelId.trim()) continue;
    const tags = normalizeAccessTags(modelAccessTags[modelId]);
    if (tags.length > 0) return tags;
  }
  return [];
}
