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

function truncatedValue(value, maxChars) {
  let preview = "[unavailable]";
  try {
    preview = copyStringPrefix(JSON.stringify(buildPreview(value)), PREVIEW_CHARS);
  } catch {}
  return {
    _truncated: true,
    // The bounded scan intentionally stops as soon as the configured budget is
    // exceeded. Avoid a second full serialization merely to obtain an exact
    // observability-only size.
    _originalSize: maxChars + 1,
    _originalSizeExact: false,
    _preview: preview,
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
    return {
      _truncated: true,
      _originalSize: serialized.length,
      _originalSizeExact: true,
      _preview: copyStringPrefix(serialized, PREVIEW_CHARS),
    };
  } catch {
    return truncatedValue(normalized, maxChars);
  }
}

export const __test__ = { copyStringPrefix, exceedsJsonBudget, buildPreview };
