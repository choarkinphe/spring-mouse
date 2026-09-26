import { AUTO_TIERS, AUTO_LEVELS, AUTO_LIMITS, DEFAULT_AUTO_ROUTING, AUTO_CLASSIFIER_PROMPT } from "../config/autoRouting.js";
import { ROLE } from "../translator/schema/index.js";
import { runWithAbortDeadline } from "../utils/abortable.js";

export { AUTO_TIERS, AUTO_LEVELS, DEFAULT_AUTO_ROUTING };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const normalizeAutoTier = (value) => AUTO_TIERS.includes(value) ? value : "balanced";
export const normalizeAutoLevel = (value) => AUTO_LEVELS.includes(value) ? value : "standard";
export const autoTierOf = (entry) => normalizeAutoTier(entry?.autoTier);
export const modelIdentifier = (entry) => typeof entry === "string" ? entry : entry?.model || "";

export function isDirectModelIdentifier(value) {
  return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value.trim());
}

function invalid(field) {
  throw new Error(`Invalid combo auto routing: ${field}`);
}

export function normalizeAutoLevelOrder(value) {
  return Object.fromEntries(AUTO_LEVELS.map((level) => {
    const defaults = DEFAULT_AUTO_ROUTING.levelOrder[level];
    const configured = Array.isArray(value?.[level]) ? value[level] : defaults;
    return [level, [...new Set([...configured.filter((tier) => AUTO_TIERS.includes(tier)), ...defaults])]];
  }));
}

export function normalizeAutoMinimumLevel(value) {
  return Object.fromEntries(Object.entries(DEFAULT_AUTO_ROUTING.minimumLevel)
    .map(([key, fallback]) => [key, AUTO_LEVELS.includes(value?.[key]) ? value[key] : fallback]));
}

export function normalizeAutoRoutingConfig(value, { strict = false } = {}) {
  if (strict && value !== undefined && !isObject(value)) invalid("configuration must be an object");
  const source = isObject(value) ? value : {};
  const result = { ...DEFAULT_AUTO_ROUTING };
  const enums = { defaultLevel: AUTO_LEVELS, inputMode: ["hybrid", "metadata"], onClassifierFailure: ["use-default"] };
  for (const [field, allowed] of Object.entries(enums)) {
    if (source[field] === undefined) continue;
    if (strict && !allowed.includes(source[field])) invalid(field);
    if (allowed.includes(source[field])) result[field] = source[field];
  }
  for (const [field, min, max, integer] of [
    ["classifierTimeoutMs", AUTO_LIMITS.timeoutMin, AUTO_LIMITS.timeoutMax, true],
    ["classifierMaxTokens", AUTO_LIMITS.tokensMin, AUTO_LIMITS.tokensMax, true],
    ["minConfidence", 0, 1, false],
    ["cacheTtlMs", 0, 0, true],
  ]) {
    const number = source[field];
    if (number === undefined) continue;
    const valid = typeof number === "number" && Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number));
    if (strict && !valid) invalid(`${field} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
    if (valid) result[field] = number;
  }
  result.classifierModel = typeof source.classifierModel === "string" ? source.classifierModel.trim() : "";
  if (strict && source.classifierModel !== undefined && (typeof source.classifierModel !== "string" || (result.classifierModel && !isDirectModelIdentifier(result.classifierModel)))) invalid("classifierModel must be a direct provider/model identifier");
  if (strict) {
    for (const field of ["levelOrder", "minimumLevel"]) {
      if (source[field] !== undefined && !isObject(source[field])) invalid(field);
    }
    for (const [level, order] of Object.entries(source.levelOrder || {})) {
      if (!AUTO_LEVELS.includes(level) || !Array.isArray(order) || order.length !== AUTO_TIERS.length || new Set(order).size !== AUTO_TIERS.length || order.some((tier) => !AUTO_TIERS.includes(tier))) invalid(`levelOrder.${level}`);
    }
    for (const [key, level] of Object.entries(source.minimumLevel || {})) {
      if (!Object.hasOwn(DEFAULT_AUTO_ROUTING.minimumLevel, key) || !AUTO_LEVELS.includes(level)) invalid(`minimumLevel.${key}`);
    }
  }
  result.levelOrder = normalizeAutoLevelOrder(source.levelOrder);
  result.minimumLevel = normalizeAutoMinimumLevel(source.minimumLevel);
  return result;
}

export function normalizeComboStrategies(value, { strict = false } = {}) {
  if (strict && !isObject(value)) invalid("comboStrategies must be an object");
  return Object.fromEntries(Object.entries(isObject(value) ? value : {}).map(([name, entry]) => {
    if (!isObject(entry)) invalid(`comboStrategies.${name}`);
    const strategy = entry.fallbackStrategy ?? "fallback";
    if (!["fallback", "round-robin", "fusion", "auto"].includes(strategy)) invalid("fallbackStrategy");
    // Existing Fusion tuning and future unrelated fields must survive an Auto edit.
    const normalized = { ...entry, fallbackStrategy: strategy };
    if (strategy === "auto" || entry.autoRouting !== undefined) normalized.autoRouting = normalizeAutoRoutingConfig(entry.autoRouting, { strict });
    return [name, normalized];
  }));
}

export function reorderByAutoLevel(models, level, levelOrder) {
  if (!Array.isArray(models) || models.length <= 1) return models;
  const order = normalizeAutoLevelOrder(levelOrder)[normalizeAutoLevel(level)];
  return [...models].sort((a, b) => order.indexOf(autoTierOf(a)) - order.indexOf(autoTierOf(b)));
}

function messagesOf(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (typeof body?.input === "string") return [{ role: ROLE.USER, content: body.input }];
  if (Array.isArray(body?.input)) return body.input;
  return body?.contents || body?.request?.contents || [];
}

function taskText(value, remaining = AUTO_LIMITS.inputChars, depth = 0) {
  if (depth > 8 || remaining <= 0 || value == null) return "";
  if (typeof value === "string") return value.slice(-remaining).replace(/data:[^\s]+/g, "[media omitted]");
  if (Array.isArray(value)) {
    let text = "";
    for (let i = value.length - 1; i >= 0 && text.length < remaining; i--) {
      text = taskText(value[i], remaining - text.length, depth + 1) + "\n" + text;
    }
    return text.slice(-remaining);
  }
  if (!isObject(value)) return "";
  return taskText(value.text ?? value.content ?? value.parts, remaining, depth + 1);
}

export function getAutoRoutingSignals(body, requiredCapabilities = new Set()) {
  const messages = messagesOf(body);
  const hasToolHistory = messages.some((message) => {
    if ([ROLE.TOOL, "function"].includes(message?.role) || message?.tool_calls?.length || message?.function_call) return true;
    if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(message?.type)) return true;
    return (message?.content || message?.parts || []).some?.((block) => ["tool_use", "tool_result"].includes(block?.type) || block?.functionCall || block?.functionResponse) || false;
  });
  let textLength = 0;
  for (const message of messages) {
    textLength += taskText(message, AUTO_LIMITS.longContextChars).length;
    if (textLength >= AUTO_LIMITS.longContextChars) break;
  }
  return {
    hasTools: !!(body?.tools?.length || body?.functions?.length),
    hasToolHistory,
    hasLongContext: textLength >= AUTO_LIMITS.longContextChars || messages.length >= AUTO_LIMITS.longContextMessages,
    hasMultimodalInput: [...requiredCapabilities].some((cap) => ["vision", "pdf", "audioInput", "videoInput"].includes(cap)),
    messageCount: messages.length,
  };
}

export function applyAutoMinimumLevel(level, signals, minimumLevel = DEFAULT_AUTO_ROUTING.minimumLevel) {
  const levels = [normalizeAutoLevel(level), ...Object.keys(minimumLevel).filter((key) => signals?.[key] === true).map((key) => normalizeAutoLevel(minimumLevel[key]))];
  return AUTO_LEVELS[Math.max(...levels.map((item) => AUTO_LEVELS.indexOf(item)))];
}

export function parseAutoClassifierOutput(value) {
  const text = typeof value === "string" ? value : value?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isObject(parsed) || Object.keys(parsed).length !== 2 || !AUTO_LEVELS.includes(parsed.level) || typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) return null;
  return { level: parsed.level, confidence: parsed.confidence };
}

export function buildAutoClassifierRequest(body, config, requiredCapabilities = new Set()) {
  const metadata = getAutoRoutingSignals(body, requiredCapabilities);
  if (config.inputMode === "hybrid") metadata.taskText = taskText(messagesOf(body).slice(-AUTO_LIMITS.historyMessages));
  return {
    model: config.classifierModel,
    messages: [{ role: ROLE.SYSTEM, content: AUTO_CLASSIFIER_PROMPT }, { role: ROLE.USER, content: JSON.stringify(metadata) }],
    max_tokens: config.classifierMaxTokens,
    stream: false,
  };
}

async function readClassifierResponse(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty classifier response");
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > AUTO_LIMITS.responseBytes) throw new Error("Classifier response too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    cancel();
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function classifyAutoRequest({ body, config, requiredCapabilities = new Set(), callModel, signal, log }) {
  const cfg = normalizeAutoRoutingConfig(config);
  const signals = getAutoRoutingSignals(body, requiredCapabilities);
  const fallback = { level: applyAutoMinimumLevel(cfg.defaultLevel, signals, cfg.minimumLevel), confidence: 0, source: "default" };
  if (!isDirectModelIdentifier(cfg.classifierModel) || typeof callModel !== "function" || signal?.aborted) return fallback;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let finished = false;
  try {
    const parsed = await runWithAbortDeadline(async () => {
      const response = await callModel(buildAutoClassifierRequest(body, cfg, requiredCapabilities), cfg.classifierModel, controller.signal);
      if (finished || controller.signal.aborted || !response?.ok) {
        response?.body?.cancel().catch(() => {});
        throw new Error("Classifier unavailable");
      }
      return parseAutoClassifierOutput(await readClassifierResponse(response, controller.signal));
    }, { signal: controller.signal, timeoutMs: cfg.classifierTimeoutMs, onTimeout: () => controller.abort("classifier_timeout") });
    if (!parsed || parsed.confidence < cfg.minConfidence) return fallback;
    return { ...parsed, level: applyAutoMinimumLevel(parsed.level, signals, cfg.minimumLevel), source: "classifier" };
  } catch {
    log?.warn?.("AUTO", `Classifier unavailable; using ${fallback.level}`);
    return fallback;
  } finally {
    finished = true;
    signal?.removeEventListener("abort", abort);
    controller.abort("classifier_finished");
  }
}
