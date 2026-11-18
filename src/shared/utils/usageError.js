// A failed usage row keeps a short excerpt of WHY it failed.
//
// usageHistory is the only record kept for every request (requestDetails holds
// just the last ~1000 and routing telemetry stores enums only), so without this
// a failed row said "upstream:400" and nothing more. Production showed the cost:
// Anthropic was rejecting a stale Claude Code version string for hours, and the
// message saying exactly that was only visible in a rotating detail table.
//
// The excerpt is bounded and single-line. Upstream bodies are often JSON with
// the useful text nested a few levels down (sometimes JSON inside a string), so
// the message is unwrapped before it is clamped.
export const USAGE_ERROR_MAX_CHARS = 300;

function messageOf(value, depth = 0) {
  if (value == null || depth > 4) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try { return messageOf(JSON.parse(trimmed), depth + 1) || trimmed; } catch { return trimmed; }
    }
    return trimmed;
  }
  if (value instanceof Error) return messageOf(value.message, depth + 1);
  if (typeof value === "object") {
    return messageOf(value.error?.message, depth + 1)
      || messageOf(value.error, depth + 1)
      || messageOf(value.message, depth + 1)
      || messageOf(value.msg, depth + 1)
      || messageOf(value.detail, depth + 1);
  }
  return String(value);
}

export function summarizeUsageError(value, max = USAGE_ERROR_MAX_CHARS) {
  const message = messageOf(value);
  if (!message) return null;
  const clean = message.replace(/<[^>]*>/g, " ").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
