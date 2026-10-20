// Browser-safe capability resolution shared by combo validation and routing UI.
import { getCapabilitiesForModel, getMeasuredCapabilitiesForConnection } from "../providers/capabilities.js";
import { COMBO_RESOLUTION_LIMITS } from "../config/runtimeConfig.js";

export const DEFAULT_COMBO_CAPABILITIES = Object.freeze({
  contextWindow: null,
  vision: false,
  audioInput: false,
});

const DECLARABLE_INPUT_CAPABILITIES = [
  ["vision", "视觉"],
  ["audioInput", "音频输入"],
];

export function normalizeComboCapabilities(value) {
  if (value == null) return { ...DEFAULT_COMBO_CAPABILITIES };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value.contextWindow;
  let contextWindow = null;
  if (raw !== undefined && raw !== null && raw !== "") {
    contextWindow = Number(raw);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null;
  }
  return { contextWindow, vision: value.vision === true, audioInput: value.audioInput === true };
}

function identifier(entry) {
  return typeof entry === "string" ? entry : String(entry?.model || "");
}

/**
 * With a combo catalog, bare member names are combo references, never a
 * same-named model from the global capability table. Qualified provider/model
 * ids always remain leaves. Without a catalog, retain the legacy leaf API.
 *
 * A branch needs one leaf satisfying ALL requested capabilities; a union of
 * separate image-only and audio-only leaves cannot serve a mixed-input request.
 * Ancestry is branch-local so shared children are not mistaken for cycles.
 */
export function createComboCapabilityResolver(options = {}) {
  const { combos, comboPath = [], getModelCapabilities, isEntryAvailable, isComboAvailable } = options;
  const catalog = combos === undefined ? null : new Map(
    (Array.isArray(combos) ? combos : combos?.combos || []).map((combo) => [combo.name, combo]),
  );
  const leafCaps = getModelCapabilities || ((id) => {
    const slash = id.indexOf("/");
    return getCapabilitiesForModel(slash > 0 ? id.slice(0, slash) : "", slash > 0 ? id.slice(slash + 1) : id);
  });

  const supports = (entry, required = [], measured = []) => {
    let remaining = COMBO_RESOLUTION_LIMITS.maxVisits;
    const visit = (node, path) => {
      if (--remaining < 0 || (isEntryAvailable && !isEntryAvailable(node))) return false;
      const id = identifier(node);
      if (!id) return false;
      if (catalog && !id.includes("/")) {
        if (path.includes(id) || path.length >= COMBO_RESOLUTION_LIMITS.maxDepth) return false;
        const combo = catalog.get(id);
        if (!combo || combo.isActive === false || (combo.kind && combo.kind !== "llm")) return false;
        if (isComboAvailable && !isComboAvailable(combo)) return false;
        const declared = normalizeComboCapabilities(combo.capabilities) || DEFAULT_COMBO_CAPABILITIES;
        if (DECLARABLE_INPUT_CAPABILITIES.some(([key]) => required.includes(key) && !declared[key])) return false;
        return Array.isArray(combo.models) && combo.models.some((child) => visit(child, [...path, id]));
      }
      const caps = leafCaps(id);
      if (!required.every((key) => caps?.[key] === true)) return false;
      if (!measured.length) return true;
      const slash = id.indexOf("/");
      const observed = getMeasuredCapabilitiesForConnection(slash > 0 ? id.slice(0, slash) : "", slash > 0 ? id.slice(slash + 1) : id, null);
      return measured.every((key) => observed[key] !== false);
    };
    return visit(entry, comboPath);
  };

  return {
    supports,
    getCapabilities(entry) {
      const id = identifier(entry);
      if (!id) return null;
      if (!catalog || id.includes("/")) return leafCaps(id);
      const combo = catalog.get(id);
      const declared = normalizeComboCapabilities(combo?.capabilities) || DEFAULT_COMBO_CAPABILITIES;
      return {
        contextWindow: combo ? declared.contextWindow : null,
        vision: supports(entry, ["vision"]),
        audioInput: supports(entry, ["audioInput"]),
      };
    },
  };
}

export function getComboCapabilityValidationError(models, capabilities, options = {}) {
  const normalized = normalizeComboCapabilities(capabilities);
  if (!normalized) return "组合能力配置无效：上下文窗口必须是正整数";
  const resolver = createComboCapabilityResolver(options);
  const members = Array.isArray(models) ? models : [];
  for (const [capability, label] of DECLARABLE_INPUT_CAPABILITIES) {
    if (normalized[capability] && !members.some((entry) => resolver.supports(entry, [capability]))) {
      return `组合声明支持${label}，但没有添加支持${label}的模型节点`;
    }
  }
  return null;
}

export function getUnsupportedComboRequestCapability(requiredCapabilities, capabilities) {
  const normalized = normalizeComboCapabilities(capabilities) || DEFAULT_COMBO_CAPABILITIES;
  for (const [capability, label] of DECLARABLE_INPUT_CAPABILITIES) {
    if (requiredCapabilities?.has(capability) && !normalized[capability]) return label;
  }
  return null;
}

export function getComboModelsForRequest(models, requiredCapabilities, capabilities, options = {}) {
  const normalized = normalizeComboCapabilities(capabilities) || DEFAULT_COMBO_CAPABILITIES;
  const required = DECLARABLE_INPUT_CAPABILITIES.map(([key]) => key)
    .filter((key) => requiredCapabilities?.has(key) && normalized[key]);
  const measured = ["pdf", "videoInput", "tools"].filter((key) => requiredCapabilities?.has(key));
  if (!required.length && !measured.length) return models;
  const resolver = createComboCapabilityResolver(options);
  return (models || []).filter((entry) => resolver.supports(entry, required, measured));
}
