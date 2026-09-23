const PREVIEW_CHARS = 200;
const PREVIEW_STRING_CHARS = 160;
const PREVIEW_MAX_DEPTH = 3;
const PREVIEW_MAX_ITEMS = 6;

function copyStringPrefix(value, maxChars) {
  // Force a small standalone string. Keeping a slice of a very large JSON
  // string can retain the large backing store in V8 until the detail expires.
  return Array.from(String(value).slice(0, maxChars)).join("");
}

function exceedsJsonBudget(value, maxChars) {
  const state = { remaining: maxChars, ancestors: new WeakSet() };

  const visit = (current) => {
    if (state.remaining < 0) return true;
    if (current === null) {
      state.remaining -= 4;
      return state.remaining < 0;
    }

    const type = typeof current;
    if (type === "string") {
      // Raw string length is a lower bound; JSON escaping can only add bytes.
      state.remaining -= current.length + 2;
      return state.remaining < 0;
    }
    if (type === "number" || type === "boolean" || type === "bigint") {
      state.remaining -= String(current).length;
      return state.remaining < 0;
    }
    if (type !== "object") return false;

    // JSON.stringify would reject an ancestor cycle. Treat it as oversized so
    // observability remains fail-open instead of breaking the business request.
    if (state.ancestors.has(current)) return true;
    state.ancestors.add(current);

    if (Array.isArray(current)) {
      state.remaining -= 2 + Math.max(0, current.length - 1);
      for (const item of current) {
        if (visit(item)) return true;
      }
    } else {
      state.remaining -= 2;
      for (const key of Object.keys(current)) {
        state.remaining -= key.length + 3;
        if (state.remaining < 0 || visit(current[key])) return true;
      }
    }

    state.ancestors.delete(current);
    return state.remaining < 0;
  };

  return visit(value);
}

function buildPreview(value, depth = 0, ancestors = new WeakSet()) {
  if (typeof value === "string") return copyStringPrefix(value, PREVIEW_STRING_CHARS);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= PREVIEW_MAX_DEPTH) return Array.isArray(value) ? ["…"] : { _preview: "…" };

  ancestors.add(value);
  let preview;
  if (Array.isArray(value)) {
    preview = value.slice(0, PREVIEW_MAX_ITEMS).map((item) => buildPreview(item, depth + 1, ancestors));
    if (value.length > PREVIEW_MAX_ITEMS) preview.push("…");
  } else {
    preview = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, PREVIEW_MAX_ITEMS)) {
      preview[key] = buildPreview(value[key], depth + 1, ancestors);
    }
    if (keys.length > PREVIEW_MAX_ITEMS) preview._preview = "…";
  }
  ancestors.delete(value);
  return preview;
}

/**
 * A human-readable digest of a chat request, for when the full body is too
 * large to store.
 *
 * The point is the QUESTION "what did the user actually send this turn", which a
 * 200-char slice of the raw JSON does not answer — the messages array is usually
 * past the truncation point, so the operator sees request metadata and none of
 * the conversation. This keeps the shape of the conversation: how many messages,
 * each one's role, and the head of its text.
 *
 * Bounded by construction: at most `maxMessages` messages, `perMessageChars`
 * each, and it gives up after `maxTotalChars` so a pathological body cannot
 * produce a large summary.
 */
const SUMMARY_MAX_MESSAGES = 12;
const SUMMARY_PER_MESSAGE_CHARS = 400;
const SUMMARY_MAX_TOTAL_CHARS = 6000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Multimodal content: keep the text parts, name the rest.
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") { parts.push(block); continue; }
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") parts.push(block.text);
      else if (block.type) parts.push(`[${block.type}]`);
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

// The operator's question is "what did the user send", not "what did the model
// answer". This is the last HUMAN-typed user turn's text only — no roles, no
// assistant replies, no relayed tool output — which is what the provider export
// calls "User Prompt". Kept short so it can sit in a table cell and be stored
// per row.
const USER_PROMPT_MAX_CHARS = 2048;

/**
 * Is this user turn actually the human typing, or just a relayed tool result?
 *
 * Agent clients (Claude Code and friends) send tool output as `role: "user"`
 * turns, so "the last user message" is very often `[tool_result]` or an attached
 * image — not the question. The provider export this mirrors never shows those
 * (0 of 3000 sampled rows), so neither do we: skip a turn whose text is entirely
 * tool/attachment markers, and keep walking back to the real prompt.
 */
function isToolRelayText(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Every line is a tool_result / tool_use / attachment marker, or an image part
  // placeholder like "[image_url]" — nothing the human typed.
  const MARKER = /^\[(tool_result|tool_use|thinking|image_url|image_local_path)\]/;
  const lines = trimmed.split("\n").filter((line) => line.trim());
  if (!lines.length) return true;
  if (lines.every((line) => MARKER.test(line.trim()))) return true;
  // The summarizer's multimodal placeholder for a whole attachment-only turn.
  if (/^Attached image\(s\) from tool result:?$/i.test(trimmed)) return true;
  return false;
}

/**
 * The user's own text from a chat request body — the last `role: "user"` turn
 * that the human actually typed.
 *
 * Deliberately narrower than `summarizeChatRequest`: that one keeps the whole
 * conversation's shape (roles, per-message heads, knob values) for the request
 * inspector. This returns just the prompt string, for the usage table's
 * "用户提问" column.
 *
 * Handles BOTH stored shapes: a body small enough to keep whole (`messages` with
 * `content`), and one `compactJsonField` replaced with a digest (`_summary`
 * whose messages carry `text`). Most production rows are the latter, so reading
 * only `messages` would silently return "" for the majority of traffic.
 *
 * Returns "" when there is no human turn (a non-chat request, or a body that was
 * compacted before the digest existed).
 */
export function extractUserPrompt(value, { maxChars = USER_PROMPT_MAX_CHARS } = {}) {
  if (!value || typeof value !== "object") return "";

  const clamp = (text) => (text.length > maxChars ? Array.from(text.slice(0, maxChars)).join("") : text);

  // Both shapes are scanned newest-first so a real prompt after tool chatter
  // still wins over the tool turns that follow it.
  const messages = Array.isArray(value.messages) ? value.messages : null;
  if (messages && messages.length) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      const text = textOf(message.content);
      if (text && !isToolRelayText(text)) return clamp(text);
    }
  }

  // Compacted body: the digest keeps each message's head under `text`.
  const summaryMessages = Array.isArray(value._summary?.messages) ? value._summary.messages : null;
  if (summaryMessages && summaryMessages.length) {
    for (let i = summaryMessages.length - 1; i >= 0; i -= 1) {
      const message = summaryMessages[i];
      if (message?.role !== "user") continue;
      const text = typeof message.text === "string" ? message.text : "";
      if (text && !isToolRelayText(text)) return clamp(text);
    }
  }

  return "";
}

export function summarizeChatRequest(value) {
  if (!value || typeof value !== "object") return null;
  const messages = Array.isArray(value.messages) ? value.messages : null;
  if (!messages || messages.length === 0) return null;

  const out = [];
  let budget = SUMMARY_MAX_TOTAL_CHARS;
  let omitted = 0;
  for (const message of messages) {
    if (out.length >= SUMMARY_MAX_MESSAGES || budget <= 0) { omitted++; continue; }
    const text = textOf(message?.content);
    const head = Array.from(text.slice(0, SUMMARY_PER_MESSAGE_CHARS)).join("");
    budget -= head.length;
    out.push({
      role: message?.role || "unknown",
      chars: text.length,
      text: head,
      truncated: text.length > head.length,
      ...(Array.isArray(message?.content) ? { parts: message.content.length } : {}),
      ...(message?.tool_calls ? { toolCalls: message.tool_calls.length } : {}),
    });
  }

  return {
    messageCount: messages.length,
    messages: out,
    omittedMessages: omitted,
    // Non-message knobs worth seeing at a glance, since they are what the
    // request-level fields above the fold do not carry.
    model: value.model ?? null,
    stream: value.stream ?? null,
    temperature: value.temperature ?? null,
    maxTokens: value.max_tokens ?? value.max_completion_tokens ?? null,
    toolCount: Array.isArray(value.tools) ? value.tools.length : null,
  };
}

function truncatedValue(value, maxChars) {
  let preview = "[unavailable]";
  try {
    preview = copyStringPrefix(JSON.stringify(buildPreview(value)), PREVIEW_CHARS);
  } catch {}
  const summary = summarizeChatRequest(value);
  return {
    _truncated: true,
    // The bounded scan intentionally stops as soon as the configured budget is
    // exceeded. Avoid a second full serialization merely to obtain an exact
    // observability-only size.
    _originalSize: maxChars + 1,
    _originalSizeExact: false,
    _preview: preview,
    ...(summary ? { _summary: summary } : {}),
  };
}

export function compactJsonField(value, maxChars) {
  const normalized = value || {};
  try {
    if (exceedsJsonBudget(normalized, maxChars)) return truncatedValue(normalized, maxChars);
  } catch {
    return truncatedValue(normalized, maxChars);
  }

  try {
    const serialized = JSON.stringify(normalized);
    if (serialized.length <= maxChars) return normalized;
    const summary = summarizeChatRequest(normalized);
    return {
      _truncated: true,
      _originalSize: serialized.length,
      _originalSizeExact: true,
      _preview: copyStringPrefix(serialized, PREVIEW_CHARS),
      ...(summary ? { _summary: summary } : {}),
    };
  } catch {
    return truncatedValue(normalized, maxChars);
  }
}

export const __test__ = { copyStringPrefix, exceedsJsonBudget, buildPreview, textOf };
