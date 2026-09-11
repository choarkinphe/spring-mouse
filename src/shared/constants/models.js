// Import directly from file to avoid pulling in server-side dependencies via index.js
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel as isValidModelCore,
  findModelName,
  getModelTargetFormat,
  getModelStrip,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
  getModelUpstreamId,
  getModelQuotaFamily
} from "open-sse/config/providerModels.js";

import { AI_PROVIDERS, isOpenAICompatibleProvider } from "./providers.js";
import { PROVIDER_MODELS as MODELS } from "open-sse/config/providerModels.js";

// Providers that accept any model (passthrough)
const PASSTHROUGH_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.passthroughModels)
    .map(([key]) => key)
);

// Wrap isValidModel with passthrough providers
export function isValidModel(aliasOrId, modelId) {
  if (isOpenAICompatibleProvider(aliasOrId)) return true;
  if (PASSTHROUGH_PROVIDERS.has(aliasOrId)) return true;
  const models = MODELS[aliasOrId];
  if (!models) return false;
  return models.some(m => m.id === modelId);
}

// Legacy AI_MODELS for backward compatibility
export const AI_MODELS = Object.entries(MODELS).flatMap(([alias, models]) =>
  models.map(m => ({ provider: alias, model: m.id, name: m.name }))
);

export const getModelKind = (m, fallback = null) => m?.kind || m?.type || fallback;

// Capacity metadata for UI badges — icon + label + color per capability.
// Order = badge render order. Keep in sync with MODEL_CAPABILITY_KEYS
// (src/shared/utils/modelCatalog.js): anything listed here shows a badge, and
// every capability the editor can toggle has an entry here.
export const CAPACITY_META = {
  vision: { icon: "visibility", label: "Vision", desc: "支持图片输入", color: "text-blue-500" },
  pdf: { icon: "picture_as_pdf", label: "PDF", desc: "支持 PDF / 文档输入", color: "text-rose-500" },
  audioInput: { icon: "mic", label: "Audio In", desc: "支持音频输入", color: "text-teal-500" },
  videoInput: { icon: "videocam", label: "Video In", desc: "支持视频输入", color: "text-indigo-500" },
  imageOutput: { icon: "image", label: "Image Out", desc: "支持图像生成", color: "text-fuchsia-500" },
  audioOutput: { icon: "volume_up", label: "Audio Out", desc: "支持音频生成", color: "text-orange-500" },
  // search: temporarily hidden (feature not wired yet)
  reasoning: { icon: "neurology", label: "Reasoning", desc: "支持思考 / 推理", color: "text-amber-500" },
};
