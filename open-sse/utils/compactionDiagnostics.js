import { createHash } from "node:crypto";
import { COMPACTION_REQUEST_HEADERS, COMPACTION_DIAGNOSTICS_LIMITS as LIMITS, COMPACTION_ERROR_CODES } from "../config/compactionDiagnostics.js";

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const BLOCKS = new Set(["text", "input_text", "output_text", "image", "image_url", "input_image", "tool_use", "tool_result", "thinking", "redacted_thinking", "function_call", "function_call_output"]);
const MODES = new Set(["enabled", "disabled", "adaptive", "between_tools"]);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const FORMATS = new Set(["openai", "openai-responses", "claude", "gemini", "gemini-cli", "antigravity", "kiro", "cursor", "commandcode"]);
const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const identifier = (value) => /^[a-f0-9-]{36}$/i.test(value || "") ? value : null;
const hashIdentifier = (value) => value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 16) : null;

export function detectCompactionRequest(headers, body, endpoint) {
  const sources = [];
  const get = (key) => typeof headers?.get === "function" ? headers.get(key)
    : Object.entries(headers || {}).find(([name]) => name.toLowerCase() === key)?.[1];
  for (const name of COMPACTION_REQUEST_HEADERS) {
    const value = get(name);
    if (value !== undefined && value !== null && String(value).trim() && !["0", "false"].includes(String(value).trim().toLowerCase())) sources.push(name);
  }
  if (body?._compact === true) sources.push("compact-body-flag");
  if (typeof endpoint === "string" && /\/responses\/compact\/?$/.test(endpoint)) sources.push("compact-endpoint");
  return sources;
}

// Only counts and known enums survive. Never serialize or retain the body, tool
// schemas, model-supplied labels, session values, or diagnostic header values.
export function compactionRequestShape(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : Array.isArray(body.contents) ? body.contents : [];
  const roles = {}; const blocks = {};
  let textChars = typeof body.input === "string" ? body.input.length : 0;
  let scannedBlocks = 0; let toolCalls = 0;
  const count = (map, value, allowed) => { const key = allowed.has(value) ? value : "other"; map[key] = (map[key] || 0) + 1; };
  for (const message of messages.slice(0, LIMITS.maxItems)) {
    count(roles, message?.role, ROLES);
    const content = message?.content ?? message?.parts;
    if (typeof content === "string") textChars += content.length;
    if (Array.isArray(message?.tool_calls)) toolCalls += message.tool_calls.length;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (scannedBlocks >= LIMITS.maxBlocks) break;
        scannedBlocks++;
        count(blocks, block?.type, BLOCKS);
        if (typeof block?.text === "string") textChars += block.text.length;
      }
    }
    if (message?.type) count(blocks, message.type, BLOCKS);
  }
  const thinking = body.thinking;
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort;
  return {
    messageCount: messages.length, roleCounts: roles, blockCounts: blocks,
    sampled: messages.length > LIMITS.maxItems || scannedBlocks >= LIMITS.maxBlocks,
    observedTextChars: textChars, toolCount: Array.isArray(body.tools) ? body.tools.length : 0, toolCalls,
    stream: typeof body.stream === "boolean" ? body.stream : null,
    maxTokens: numeric(body.max_tokens), maxCompletionTokens: numeric(body.max_completion_tokens), maxOutputTokens: numeric(body.max_output_tokens),
    thinkingPresent: thinking !== undefined, thinkingType: MODES.has(thinking?.type) ? thinking.type : thinking?.type ? "other" : null,
    thinkingBudget: numeric(thinking?.budget_tokens), thinkingBudgetQwen: numeric(body.thinking_budget),
    enableThinking: typeof body.enable_thinking === "boolean" ? body.enable_thinking : null,
    reasoningEffort: EFFORTS.has(effort) ? effort : effort !== undefined ? "other" : null,
    temperature: numeric(body.temperature), topP: numeric(body.top_p),
  };
}

export function compactionErrorShape(raw) {
  let error = raw;
  if (typeof raw === "string") {
    if (raw.length > LIMITS.maxErrorChars) return { parsed: false, oversized: true };
    try { error = JSON.parse(raw); } catch { return { parsed: false, oversized: false }; }
  }
  if (!error || typeof error !== "object") return { parsed: false };
  const safeCode = (value) => typeof value === "number" && Number.isFinite(value) ? value : COMPACTION_ERROR_CODES.has(value) ? value : value ? "other" : null;
  return {
    parsed: true, code: safeCode(error.code), errorType: safeCode(error.type ?? error.error?.type),
    nestedCode: safeCode(error.extError?.code ?? error.error?.code),
    status: numeric(error.extError?.StatusCode ?? error.status),
    upstreamRequestId: identifier(error.requestId ?? error.request_id),
  };
}

export function createCompactionDiagnostics({ headers, body, endpoint, requestId, trafficRequestId, connectionId, provider, model, sourceFormat, targetFormat, log, reqTag, now = Date.now }) {
  try {
    const sources = detectCompactionRequest(headers, body, endpoint);
    if (!sources.length) return null;
    const startedAt = now();
    const context = {
      requestId: identifier(requestId), trafficRequestId: identifier(trafficRequestId),
      accountHash: hashIdentifier(connectionId), providerHash: hashIdentifier(provider), modelHash: hashIdentifier(model),
      sourceFormat: FORMATS.has(sourceFormat) ? sourceFormat : "other",
      targetFormat: FORMATS.has(targetFormat) ? targetFormat : "other",
      sources, client: compactionRequestShape(body),
    };
    let finished = false;
    return {
      emit(phase, { body: outbound, status = null, error = null, outcome = null } = {}) {
        try {
          if (phase === "end" && finished) return;
          if (phase === "end") finished = true;
          const record = { ...context, phase, elapsedMs: Math.max(0, now() - startedAt), status: numeric(status), outcome,
            ...(outbound ? { providerRequest: compactionRequestShape(outbound) } : {}),
            ...(error ? { upstreamError: compactionErrorShape(error) } : {}),
          };
          log?.errorLine?.(reqTag || "", "🔬", `COMPACTION-DIAG | ${JSON.stringify(record)}`);
        } catch { /* observation must never change request behavior */ }
      },
    };
  } catch { return null; }
}
