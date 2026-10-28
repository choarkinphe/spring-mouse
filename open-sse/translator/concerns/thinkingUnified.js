// Unified thinking normalization: extract client intent → apply provider-native format.
// Config-driven: thinking format/limits come from capabilities.js + registry transport,
// never hardcoded per-model here. See .docs/thinking/plan.md MATRIX VI-A.

import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { getThinkingLevels } from "../../providers/thinkingLevels.js";
import { PROVIDERS } from "../../providers/index.js";
import { LEVEL_TO_BUDGET, budgetToLevel, effortToBudget, effortToThinkingLevel } from "./thinking.js";

// Map a target wire-format to its native thinking format (when capability has none).
const FORMAT_TO_NATIVE = {
  openai: "openai",
  "openai-responses": "openai",
  "openai-response": "openai",
  codex: "openai",
  claude: "claude-budget",
  gemini: "gemini-budget",
  "gemini-cli": "gemini-budget",
  vertex: "gemini-budget",
  antigravity: "gemini-budget",
  kiro: "kiro",
};

// Strip a trailing thinking suffix "model(value)" → "model" (no-op when absent).
export function stripThinkingSuffix(model) {
  if (typeof model !== "string") return model;
  const m = model.match(/^(.*)\([^()]+\)\s*$/);
  return m ? m[1].trim() : model;
}

// Parse model-name suffix "model(value)" → { cleanModel, override }.
// value: level name (high) | number (8192) | auto | none. null override when absent.
export function parseSuffix(model) {
  if (typeof model !== "string") return { cleanModel: model, override: null };
  const m = model.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!m) return { cleanModel: model, override: null };
  const cleanModel = m[1].trim();
  const raw = m[2].trim().toLowerCase();
  if (raw === "none" || raw === "off") return { cleanModel, override: { mode: "none" } };
  if (raw === "auto") return { cleanModel, override: { mode: "auto" } };
  if (raw === "ultra") return { cleanModel, override: { mode: "level", level: raw } };
  if (/^\d+$/.test(raw)) return { cleanModel, override: { mode: "budget", budget: Number(raw) } };
  if (LEVEL_TO_BUDGET[raw] !== undefined) return { cleanModel, override: { mode: "level", level: raw } };
  return { cleanModel, override: null };
}

// Extract unified thinking intent from a request body (post-translation, mixed shapes).
// Returns { mode, budget?, level? } or null when no thinking intent present.
export function extractThinking(body) {
  if (!body || typeof body !== "object") return null;

  // Claude output_config.effort (explicit) — priority over adaptive thinking
  const oc = body.output_config?.effort;
  if (typeof oc === "string" && oc) {
    const e = oc.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // Claude shape
  const t = body.thinking;
  if (t && typeof t === "object") {
    if (t.type === "disabled") return { mode: "none" };
    if ((t.type === "adaptive" || t.type === "enabled") && !body.reasoning_effort && !body.reasoning?.effort) {
      const budget = Number(t.budget_tokens);
      if (Number.isFinite(budget) && budget > 0) return { mode: "budget", budget };
      return { mode: "auto" };
    }
  }

  // OpenAI chat / Responses shape
  const effort = body.reasoning_effort ?? (typeof body.reasoning === "object" ? body.reasoning?.effort : null);
  if (typeof effort === "string" && effort) {
    const e = effort.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // Gemini shape (top-level, generationConfig, or request envelope)
  const tc = body.thinkingConfig || body.generationConfig?.thinkingConfig || body.request?.generationConfig?.thinkingConfig;
  if (tc && typeof tc === "object") {
    if (typeof tc.thinkingLevel === "string") return { mode: "level", level: tc.thinkingLevel.toLowerCase() };
    const tb = Number(tc.thinkingBudget);
    if (Number.isFinite(tb)) {
      if (tb === 0) return { mode: "none" };
      if (tb < 0) return { mode: "auto" };
      return { mode: "budget", budget: tb };
    }
  }

  // Qwen shape
  if (body.enable_thinking === false) return { mode: "none" };
  if (body.enable_thinking === true) {
    const tb = Number(body.thinking_budget);
    if (Number.isFinite(tb) && tb > 0) return { mode: "budget", budget: tb };
    return { mode: "auto" };
  }

  return null;
}

// Clamp recognized thinking suffixes when the routing model is held separately.
export function capThinkingModel(model, ceiling) {
  const limit = ceilingBudget(ceiling);
  const { cleanModel, override } = parseSuffix(model);
  if (!override) return model;
  if (override.mode === "none") return model;
  if (limit === 0) return `${cleanModel}(none)`;
  if (override.mode === "budget") {
    return override.budget > limit ? `${cleanModel}(${limit})` : model;
  }
  if (override.mode === "auto" || levelExceeds(override.level, limit)) {
    return `${cleanModel}(${ceiling.toLowerCase()})`;
  }
  return model;
}

function ceilingBudget(ceiling) {
  const level = typeof ceiling === "string" ? ceiling.toLowerCase() : "";
  const budget = LEVEL_TO_BUDGET[level];
  if (!Object.hasOwn(LEVEL_TO_BUDGET, level) || !Number.isFinite(budget) || budget < 0) {
    throw new RangeError("Thinking ceiling must be a supported effort level");
  }
  return budget;
}

function levelExceeds(level, limit) {
  if (typeof level !== "string") return false;
  const normalized = level.toLowerCase();
  // Ultra is supported by some models but has no numeric mapping in thinking.js.
  if (normalized === "off") return false;
  return !Object.hasOwn(LEVEL_TO_BUDGET, normalized) || LEVEL_TO_BUDGET[normalized] > limit;
}

// Return a deep clone with only existing thinking intent capped. This deliberately
// does not translate formats or introduce thinking when the request has no intent.
// Pass the routing model when it differs from body.model; cap that routing model
// with capThinkingModel too, because a suffix overrides body fields downstream.
export function capThinking(body, ceiling, model = body?.model) {
  const limit = ceilingBudget(ceiling);
  const level = ceiling.toLowerCase();
  const out = structuredClone(body);
  if (!out || typeof out !== "object" || Array.isArray(out)) return out;

  const capLevel = (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.toLowerCase();
    return normalized === "auto" || levelExceeds(normalized, limit) ? level : value;
  };
  const isBudget = (value) => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
  const capBudget = (value) => isBudget(value) && (Number(value) < 0 || Number(value) > limit) ? limit : value;

  if (typeof out.model === "string") out.model = capThinkingModel(out.model, ceiling);
  const suffix = parseSuffix(model).override;
  // An explicit disabled suffix overrides the body, so leave its intent untouched.
  if (suffix?.mode === "none" || (suffix?.mode === "budget" && suffix.budget === 0)) return out;

  if (out.output_config && typeof out.output_config === "object") {
    out.output_config.effort = capLevel(out.output_config.effort);
    if (out.output_config.effort === undefined) delete out.output_config.effort;
  }
  if (typeof out.reasoning_effort === "string") out.reasoning_effort = capLevel(out.reasoning_effort);
  if (out.reasoning && typeof out.reasoning === "object" && typeof out.reasoning.effort === "string") {
    out.reasoning.effort = capLevel(out.reasoning.effort);
  }
  const thinking = out.thinking;
  if (thinking && typeof thinking === "object" && thinking.type !== "disabled") {
    if (limit === 0 && (thinking.type === "adaptive" || thinking.type === "enabled")) {
      thinking.type = "disabled";
      delete thinking.budget_tokens;
      if (out.output_config && typeof out.output_config === "object") delete out.output_config.effort;
    } else if (isBudget(thinking.budget_tokens)) thinking.budget_tokens = capBudget(thinking.budget_tokens);
    else if (thinking.type === "adaptive") {
      out.output_config = { ...out.output_config, effort: capLevel(out.output_config?.effort ?? "auto") };
    } else if (thinking.type === "enabled" && !out.reasoning_effort && !out.reasoning?.effort && !out.output_config?.effort) {
      thinking.budget_tokens = limit;
    }
  }
  for (const tc of [out.thinkingConfig, out.generationConfig?.thinkingConfig, out.request?.generationConfig?.thinkingConfig]) {
    if (!tc || typeof tc !== "object") continue;
    if (typeof tc.thinkingLevel === "string") tc.thinkingLevel = capLevel(tc.thinkingLevel);
    if (isBudget(tc.thinkingBudget)) tc.thinkingBudget = capBudget(tc.thinkingBudget);
  }
  if (out.enable_thinking === true) {
    if (limit === 0) out.enable_thinking = false;
    if (isBudget(out.thinking_budget)) out.thinking_budget = capBudget(out.thinking_budget);
    else out.thinking_budget = limit;
  }
  return out;
}

// Capture thinking intent from a body. Alias of extractThinking, named for clarity
// at the call-site where intent is snapshotted before format translation.
export const captureThinking = extractThinking;

// Resolve thinking format: provider override > capability > derive(targetFormat).
function resolveFormat(targetFormat, model, provider) {
  const transportFmt = provider ? PROVIDERS[provider]?.thinkingFormats?.[targetFormat] : null;
  if (transportFmt) return transportFmt;
  const providerFmt = provider ? PROVIDERS[provider]?.thinkingFormat : null;
  if (providerFmt) return providerFmt;
  const caps = getCapabilitiesForModel(provider, model);
  if (caps.thinkingFormat) return caps.thinkingFormat;
  return FORMAT_TO_NATIVE[targetFormat] || "openai";
}

// Convert unified config to a budget number (for budget-based formats).
function toBudget(cfg, range) {
  let budget;
  if (cfg.mode === "budget") budget = cfg.budget;
  else if (cfg.mode === "level") budget = effortToBudget(cfg.level);
  else if (cfg.mode === "auto") return -1;
  if (!Number.isFinite(budget)) return undefined;
  if (range) {
    if (range.min != null && budget < range.min) budget = range.min;
    if (range.max != null && budget > range.max) budget = range.max;
  }
  return budget;
}

// Convert unified config to a discrete level string.
function toLevel(cfg) {
  if (cfg.mode === "level") return cfg.level;
  if (cfg.mode === "budget") return budgetToLevel(cfg.budget) || "medium";
  if (cfg.mode === "auto") return "auto";
  return null;
}

function normalizeOpenAILevel(level, supportedLevels) {
  if (level !== "max" && level !== "ultra") return level;
  if (supportedLevels?.includes(level)) return level;
  if (level === "ultra" && supportedLevels?.includes("max")) return "max";
  return "xhigh";
}

function toGeminiThinkingLevel(cfg) {
  const raw = cfg.mode === "auto" ? "high" : (toLevel(cfg) || "high");
  return effortToThinkingLevel(raw);
}

function toKimiReasoningEffort(cfg) {
  const level = toLevel(cfg);
  if (level === "auto") return "high";
  if (level === "minimal") return "low";
  if (level === "xhigh") return "max";
  if (["low", "medium", "high", "max"].includes(level)) return level;
  return null;
}

const GEMINI_LEVEL_OUTPUT_FLOOR = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 65535,
};

function geminiBudgetOutputFloor(budget) {
  if (budget === -1) return 32768;
  if (!Number.isFinite(budget)) return 32768;
  if (budget <= 1024) return 8192;
  if (budget <= 8192) return 16384;
  if (budget <= 24576) return 32768;
  return 65535;
}

function geminiLevelOutputFloor(level) {
  return GEMINI_LEVEL_OUTPUT_FLOOR[level] || GEMINI_LEVEL_OUTPUT_FLOOR.high;
}

// Gemini nests thinkingConfig under generationConfig. gemini-cli / antigravity wrap
// the whole request in a { request: { generationConfig } } envelope — target the
// envelope's generationConfig when present, else the top-level one.
function getGeminiGenerationConfig(body) {
  if (body.request && typeof body.request === "object") {
    if (!body.request.generationConfig || typeof body.request.generationConfig !== "object") {
      body.request.generationConfig = {};
    }
    return body.request.generationConfig;
  }
  if (!body.generationConfig || typeof body.generationConfig !== "object") {
    body.generationConfig = {};
  }
  return body.generationConfig;
}

function setGeminiThinking(body, tc) {
  const gc = getGeminiGenerationConfig(body);
  gc.thinkingConfig = tc;
}

function ensureGeminiOutputFloor(body, floor, caps) {
  const cap = Number.isFinite(caps?.maxOutput) ? caps.maxOutput : floor;
  const target = Math.min(floor, cap);
  const gc = getGeminiGenerationConfig(body);
  const current = Number(gc.maxOutputTokens);
  if (!Number.isFinite(current) || current < target) {
    gc.maxOutputTokens = target;
  }
}

// Strip every known thinking field from a body (used before re-applying / when unsupported).
function stripAll(body) {
  delete body.thinking;
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinkingConfig;
  delete body.enable_thinking;
  delete body.thinking_budget;
  delete body.output_config;
  if (body.generationConfig) delete body.generationConfig.thinkingConfig;
  if (body.request?.generationConfig) delete body.request.generationConfig.thinkingConfig;
}

// Apply unified thinking config to body in the resolved provider-native format.
function applyFormat(fmt, body, cfg, caps, supportedLevels) {
  const none = cfg.mode === "none";
  const canDisable = caps.thinkingCanDisable !== false;
  // Model cannot disable thinking → clamp "none" to minimal effort instead.
  const eff = none && !canDisable ? { mode: "level", level: "minimal" } : cfg;

  switch (fmt) {
    case "openai": {
      if (none && canDisable) { body.reasoning_effort = "none"; break; }
      const level = toLevel(eff);
      if (level) body.reasoning_effort = normalizeOpenAILevel(level, supportedLevels);
      break;
    }
    case "claude-adaptive": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      // output_config.effort alone does NOT turn thinking on: Anthropic requires
      // an explicit thinking:{type:"adaptive"} on Opus 4.6/4.7/4.8 and Sonnet 4.6
      // ("thinking is off unless you explicitly set it"), and Anthropic-compatible
      // shims (e.g. GitHub Copilot /v1/messages) default thinking off even for
      // Sonnet 5. Send both fields — the documented adaptive-thinking shape.
      body.thinking = { type: "adaptive" };
      const level = toLevel(eff);
      body.output_config = { effort: level === "xhigh" ? "high" : level };
      break;
    }
    case "claude-budget": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const budget = toBudget(eff, caps.thinkingRange);
      body.thinking = budget === -1 ? { type: "enabled" } : { type: "enabled", budget_tokens: budget || 8192 };
      break;
    }
    case "gemini-level": {
      const level = none ? "minimal" : toGeminiThinkingLevel(eff);
      setGeminiThinking(body, { thinkingLevel: level, includeThoughts: level !== "minimal" });
      ensureGeminiOutputFloor(body, geminiLevelOutputFloor(level), caps);
      break;
    }
    case "gemini-budget": {
      if (none && canDisable) { setGeminiThinking(body, { thinkingBudget: 0, includeThoughts: false }); break; }
      const budget = toBudget(eff, caps.thinkingRange);
      setGeminiThinking(body, { thinkingBudget: budget ?? -1, includeThoughts: true });
      ensureGeminiOutputFloor(body, geminiBudgetOutputFloor(budget ?? -1), caps);
      break;
    }
    case "zai": {
      // Z.ai ignores thinking.disabled → must use enable_thinking:false to turn off.
      if (none && canDisable) { body.enable_thinking = false; delete body.thinking; break; }
      body.thinking = { type: "enabled" };
      break;
    }
    case "zai-effort": {
      // https://docs.z.ai/guides/llm/glm-5.3: disabled -> enabled + low.
      // Leave the provider default intact for auto; never silently turn low into max.
      body.thinking = { type: "enabled" };
      const level = toLevel(eff);
      if (level === "minimal" || level === "low") body.reasoning_effort = "low";
      else if (level === "medium" || level === "high") body.reasoning_effort = "high";
      else if (["xhigh", "max", "ultra"].includes(level)) body.reasoning_effort = "max";
      break;
    }
    case "qwen-responses": {
      // Responses supports reasoning.effort, not thinking_budget. Preserve the
      // requested level instead of falling back to the upstream's default depth.
      if (none && canDisable) { body.reasoning = { effort: "none" }; break; }
      const level = toLevel(eff);
      if (level && level !== "auto") {
        body.reasoning = { effort: normalizeOpenAILevel(level, supportedLevels) };
      } else {
        body.enable_thinking = true;
      }
      break;
    }
    case "qwen": {
      if (none && canDisable) { body.enable_thinking = false; break; }
      body.enable_thinking = true;
      const budget = toBudget(eff, caps.thinkingRange);
      if (Number.isFinite(budget) && budget > 0) body.thinking_budget = budget;
      break;
    }
    case "deepseek": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      body.thinking = { type: "enabled" };
      // DeepSeek: low/medium→high, xhigh/max→max.
      const level = toLevel(eff);
      body.reasoning_effort = level === "xhigh" || level === "max" ? "max" : "high";
      break;
    }
    case "kimi": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const effort = toKimiReasoningEffort(eff);
      if (effort) body.reasoning_effort = effort;
      break;
    }
    case "minimax": {
      // M3 adaptive; M2.x cannot disable (handled via canDisable clamp).
      body.thinking = { type: none && canDisable ? "disabled" : "adaptive" };
      break;
    }
    case "hunyuan": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const budget = toBudget(eff, caps.thinkingRange);
      body.thinking = budget === -1 ? { type: "enabled" } : { type: "enabled", budget_tokens: budget || 8192 };
      break;
    }
    case "step": {
      if (none && canDisable) break;
      const level = toLevel(eff);
      if (level) body.reasoning_effort = level === "xhigh" || level === "max" ? "high" : level;
      break;
    }
    case "tokenrouter": {
      // TokenRouter's reasoning_effort enum is low/medium/high/xhigh/max — it rejects
      // "none"/"auto" with a 400 and supports "max" natively (no clamp like openai).
      // "none" → omit the field so the upstream default applies; pass levels through.
      if (none || eff.mode === "auto") break;
      const level = toLevel(eff);
      if (level) body.reasoning_effort = level;
      break;
    }
    case "kiro":
      // Kiro thinking handled via system-tag injection in openai-to-kiro.js; no body field here.
      break;
    default:
      break;
  }
}

// Public entry: normalize thinking for the resolved target format.
// Mutates and returns body. No-op when model has no reasoning capability.
// `intent` is a pre-captured config (from captureThinking on the original body);
// falls back to extracting from the current body when omitted.
export function applyThinking(targetFormat, model, body, provider = null, intent = undefined) {
  if (!body || typeof body !== "object") return body;

  const { cleanModel, override } = parseSuffix(model);
  const cfg = override || intent || extractThinking(body);
  const caps = getCapabilitiesForModel(provider, cleanModel);

  // Model cannot reason → strip any stray thinking fields.
  if (!caps.reasoning) {
    stripAll(body);
    return body;
  }
  if (!cfg) return body;

  const fmt = resolveFormat(targetFormat, cleanModel, provider);
  const supportedLevels = getThinkingLevels(provider, cleanModel);
  stripAll(body);
  applyFormat(fmt, body, cfg, caps, supportedLevels);
  return body;
}
