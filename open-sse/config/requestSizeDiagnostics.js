// Observation only. No request size limit or routing/retry policy is changed.
export const REQUEST_SIZE_DIAGNOSTICS = Object.freeze({
  providers: ["codex"],
  maxItems: 10000,
  maxBlocks: 20000,
});
export const REQUEST_SIZE_IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);
