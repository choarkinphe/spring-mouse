// Pure helpers for the chat-debug page: SSE parsing, formatting, stats and
// history persistence. No React — imported by the client components.

import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

export const PROVISION_KEY_NAME = "调试工具";
export const HISTORY_STORAGE_KEY = "chat-debug.history";
export const MODEL_STORAGE_KEY = "chat-debug.model";
export const MAX_HISTORY = 50;
export const MAX_ATTACHMENTS_PER_TURN = 4;

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return "";
}

export async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// User turn → OpenAI content parts (text + image_url data URIs), or a plain
// string when there are no usable attachments.
export function buildUserContent(text, attachments) {
  const trimmed = textValue(text).trim();
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return trimmed;

  const content = [];
  if (trimmed) content.push({ type: "text", text: trimmed });
  for (const attachment of list) {
    if (attachment?.dataUrl) {
      content.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    }
  }
  return content.length > 0 ? content : trimmed;
}

// Extract streaming deltas from an OpenAI-shaped chunk. reasoning_content is
// tracked separately so it can render in a collapsible block.
export function readDelta(chunk) {
  const result = { content: "", reasoning: "" };
  if (!chunk || typeof chunk !== "object") return result;
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  if (typeof delta.content === "string" && delta.content) result.content = delta.content;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) result.reasoning = delta.reasoning_content;
  if (typeof delta.reasoning === "string" && delta.reasoning) result.reasoning = delta.reasoning;
  // Upstreams that ignore stream:true return a single JSON body instead of SSE.
  if (!result.content && !choice?.delta) {
    const message = choice?.message?.content;
    if (typeof message === "string" && message) result.content = message;
    else if (typeof chunk.output_text === "string" && chunk.output_text) result.content = chunk.output_text;
  }
  return result;
}

export function extractUsage(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.usage && typeof chunk.usage === "object") return chunk.usage;
  const choiceUsage = chunk.choices?.[0]?.usage;
  if (choiceUsage && typeof choiceUsage === "object") return choiceUsage;
  return null;
}

export function formatMs(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function formatTokPerSec(value) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return `${value.toFixed(1)} tok/s`;
}

export function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

// Downsample chunk arrival timestamps for the timeline sparkline.
export function sampleTimeline(chunkTimes, t0, limit = 200) {
  if (!Array.isArray(chunkTimes) || chunkTimes.length === 0) return [];
  const relative = chunkTimes.map((t) => Math.max(0, t - t0));
  if (relative.length <= limit) return relative.map(Math.round);
  const step = relative.length / limit;
  const out = [];
  for (let i = 0; i < limit; i += 1) {
    out.push(Math.round(relative[Math.floor(i * step)]));
  }
  return out;
}

// Final metrics for one run. Falls back to a chars/4 token estimate when the
// gateway could not inject an exact usage block (usageEstimated=true).
export function computeRunStats({ ttft, totalMs, chunkTimes, usage, textLen }) {
  const chunks = Array.isArray(chunkTimes) ? chunkTimes.length : 0;
  let promptTokens = null;
  let completionTokens = null;
  let usageEstimated = false;

  if (usage) {
    promptTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens
      : Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
    completionTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens
      : Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
    if (usage.estimated === true) usageEstimated = true;
  }
  if (completionTokens == null && textLen > 0) {
    completionTokens = Math.round(textLen / 4);
    usageEstimated = true;
  }

  let tokPerSec = null;
  if (completionTokens != null && ttft != null && totalMs - ttft > 200) {
    tokPerSec = completionTokens / ((totalMs - ttft) / 1000);
  }

  let avgIntervalMs = null;
  if (chunks > 1) {
    const times = chunkTimes;
    avgIntervalMs = (times[times.length - 1] - times[0]) / (times.length - 1);
  }

  return {
    ttft: ttft != null ? Math.round(ttft) : null,
    total: Math.round(totalMs),
    promptTokens,
    completionTokens,
    usageEstimated,
    tokPerSec,
    chunks,
    avgIntervalMs: avgIntervalMs != null ? Math.round(avgIntervalMs) : null,
  };
}

function sanitizeRunHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: typeof entry.id === "string" ? entry.id : createId(),
    time: typeof entry.time === "string" ? entry.time : new Date().toISOString(),
    model: typeof entry.model === "string" ? entry.model : "",
    status: ["done", "error", "aborted"].includes(entry.status) ? entry.status : "done",
    error: typeof entry.error === "string" ? entry.error : null,
    httpStatus: Number.isFinite(entry.httpStatus) ? entry.httpStatus : null,
    ttft: Number.isFinite(entry.ttft) ? entry.ttft : null,
    total: Number.isFinite(entry.total) ? entry.total : 0,
    promptTokens: Number.isFinite(entry.promptTokens) ? entry.promptTokens : null,
    completionTokens: Number.isFinite(entry.completionTokens) ? entry.completionTokens : null,
    usageEstimated: entry.usageEstimated === true,
    tokPerSec: Number.isFinite(entry.tokPerSec) ? entry.tokPerSec : null,
    chunks: Number.isFinite(entry.chunks) ? entry.chunks : 0,
    avgIntervalMs: Number.isFinite(entry.avgIntervalMs) ? entry.avgIntervalMs : null,
    timeline: Array.isArray(entry.timeline) ? entry.timeline.slice(0, 200) : [],
  };
}

// History rows are metrics only — chat content, attachments and API keys are
// never persisted.
export function loadHistory() {
  try {
    const raw = globalThis.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeRunHistoryEntry).filter(Boolean).slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

export function saveHistory(runs) {
  try {
    const rows = (Array.isArray(runs) ? runs : []).slice(0, MAX_HISTORY).map(sanitizeRunHistoryEntry).filter(Boolean);
    globalThis.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Storage may be unavailable (private mode) — history stays in memory.
  }
}

// The repo has no sanitizer dependency (ChangelogModal precedent renders raw
// marked output). Content comes from the operator's own gateway; still strip
// the obvious active-content vectors.
export function renderMarkdown(text) {
  const html = marked.parse(String(text || ""));
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/ on\w+="[^"]*"/gi, "")
    .replace(/javascript:/gi, "");
}

// Normalize a combo member entry ("alias/model" string or {model, schedule}).
export function comboMemberModel(member) {
  if (typeof member === "string") return member;
  if (member && typeof member.model === "string") return member.model;
  return null;
}
