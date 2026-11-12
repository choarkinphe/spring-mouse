import { CODEX_NATIVE_IMAGE_MODEL } from "../config/codexImage.js";

// Check resolved provider/model leaves, not user-facing aliases or combo names.
// Do not reject chat models merely because they accept images or image tools.
export function getChatModelError(provider, model) {
  if (provider === "codex" && model === CODEX_NATIVE_IMAGE_MODEL) {
    return `Model "${model}" is an image generation model, not a chat model. Use POST /v1/images/generations with model "cx/${model}" and a prompt; do not send it to /v1/chat/completions or /v1/responses.`;
  }
  return null;
}
