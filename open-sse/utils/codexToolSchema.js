// Codex-specific tool JSON Schema compatibility.
// Codex's schema validator does not support Unicode property escapes such as
// `\\p{Cc}` in a function parameter `pattern`. Remove only those unsupported
// constraints on the Codex dispatch path; other providers keep their schemas
// unchanged.

// An odd number of preceding backslashes means the property escape is active.
// An even number means the backslash itself is escaped and the text is literal.
const UNICODE_PROPERTY_ESCAPE = /(^|[^\\])(\\\\)*\\[pP]\{/;

export function hasUnicodePropertyEscape(pattern) {
  return typeof pattern === "string" && UNICODE_PROPERTY_ESCAPE.test(pattern);
}

function stripNode(node, stats) {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const cleaned = stripNode(item, stats);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && hasUnicodePropertyEscape(value)) {
      stats.removed += 1;
      changed = true;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      let propertiesChanged = false;
      const properties = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        const cleaned = stripNode(propertySchema, stats);
        if (cleaned !== propertySchema) propertiesChanged = true;
        properties[propertyName] = cleaned;
      }
      if (propertiesChanged) changed = true;
      next[key] = propertiesChanged ? properties : value;
      continue;
    }
    const cleaned = stripNode(value, stats);
    if (cleaned !== value) changed = true;
    next[key] = cleaned;
  }
  return changed ? next : node;
}

export function stripCodexUnsupportedPatterns(schema, stats = { removed: 0 }) {
  return stripNode(schema, stats);
}
